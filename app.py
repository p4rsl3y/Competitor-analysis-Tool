import os
import json
import re
import socket
import time
import uuid
import sys
from flask import Flask, request, jsonify, send_file, redirect, session
from dotenv import load_dotenv
from openai import OpenAI
from anthropic import Anthropic
from cryptography.fernet import Fernet
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm.attributes import flag_modified

# Load keys from the .env file
load_dotenv()

app = Flask(__name__)
# Secret key is required to encrypt user sessions
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "super-secret-local-key")

# Encryption setup
encryption_key = os.environ.get("ENCRYPTION_KEY")
if encryption_key:
    try:
        fernet = Fernet(encryption_key.encode())
    except ValueError:
        print("\n--- FATAL STARTUP ERROR ---")
        print("The ENCRYPTION_KEY in your .env file is invalid.")
        print("It must be a 32-byte URL-safe base64-encoded key.")
        new_key = Fernet.generate_key().decode()
        print(
            "\nTo fix this, copy the following line and paste it into your .env file, replacing the old key:\n"
        )
        print(f"ENCRYPTION_KEY={new_key}\n")
        sys.exit(1)
else:
    fernet = None
    print(
        "WARNING: ENCRYPTION_KEY is not set in the .env file. API key storage will be disabled."
    )

# Database Configuration (Uses PostgreSQL on servers, SQLite locally)
# Heroku/Render use 'postgres://' which SQLAlchemy requires as 'postgresql://'
db_url = os.environ.get("DATABASE_URL", "sqlite:///app_data.db")
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["PERMANENT_SESSION_LIFETIME"] = 2592000  # 30 days
db = SQLAlchemy(app)

# Cache for model fetching
model_cache = {"data": None, "timestamp": 0}
CACHE_TTL = 3600
clients = {"openai": None, "anthropic": None}


# ─── Database Models ────────────────────────────────────────────────────────
class User(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    settings = db.relationship("UserSettings", backref="user", uselist=False)
    comparisons = db.relationship("Comparison", backref="user")


class UserSettings(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        db.String(50), db.ForeignKey("user.id"), unique=True, nullable=False
    )
    columns = db.Column(db.JSON, default=list)
    presets = db.Column(db.JSON, default=dict)


class GlobalSettings(db.Model):
    id = db.Column(db.Integer, primary_key=True, default=1)
    encrypted_openai_key = db.Column(db.String(256))
    encrypted_anthropic_key = db.Column(db.String(256))


class Comparison(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(50), db.ForeignKey("user.id"), nullable=False)
    company_name = db.Column(db.String(100), nullable=False)
    opponent_name = db.Column(db.String(100), nullable=False, server_default="Unknown")
    net_score = db.Column(db.Integer, default=0)
    timestamp = db.Column(db.Float, default=time.time)
    data = db.Column(db.JSON, default=list)


class CompanyInfo(db.Model):
    name = db.Column(db.String(100), primary_key=True)
    region = db.Column(db.String(50), server_default="RoW")
    category = db.Column(db.String(100), server_default="Unknown")


# Initialize database
with app.app_context():
    print("Checking/Creating database...")
    db.create_all()
    if not GlobalSettings.query.get(1):
        db.session.add(GlobalSettings(id=1))
        db.session.commit()
    print("Database initialization complete.")


# ─── Helper Functions ───────────────────────────────────────────────────────
def encrypt_key(key):
    if not fernet:
        raise Exception("ENCRYPTION_KEY not set.")
    return fernet.encrypt(key.encode()).decode()


def decrypt_key(encrypted_key):
    if not fernet:
        raise Exception("ENCRYPTION_KEY not set.")
    if not encrypted_key:
        return None
    return fernet.decrypt(encrypted_key.encode()).decode()


def get_global_api_key(provider):
    settings = GlobalSettings.query.get(1)
    if not settings:
        return None

    encrypted_key = (
        settings.encrypted_openai_key
        if provider == "openai"
        else settings.encrypted_anthropic_key
    )
    if not encrypted_key:
        return None

    try:
        return decrypt_key(encrypted_key)
    except Exception:
        return None


def get_client(provider, user_id):
    api_key = get_global_api_key(provider)
    if not api_key:
        return None
    return (
        OpenAI(api_key=api_key) if provider == "openai" else Anthropic(api_key=api_key)
    )


def extract_json(raw_text):
    cleaned = re.sub(r"```json|```", "", raw_text, flags=re.IGNORECASE).strip()
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        raise ValueError("Could not find JSON structure in response.")
    return json.loads(match.group(0))


def format_model_label(model_id):
    date_str = ""
    base_name = model_id

    dash_date = re.search(r"-(\d{4}-\d{2}-\d{2})$", model_id)
    solid_date = re.search(r"-(\d{8})$", model_id)

    if dash_date:
        date_str = dash_date.group(1)
        base_name = model_id[: dash_date.start()]
    elif solid_date:
        d = solid_date.group(1)
        date_str = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        base_name = model_id[: solid_date.start()]

    if base_name.startswith("claude"):
        version_match = re.search(r"-(\d+(?:-\d+)?)(?:-|$)", base_name)
        tier_match = re.search(r"-(sonnet|opus|haiku)", base_name)
        if version_match and tier_match:
            version = version_match.group(1).replace("-", ".")
            tier = tier_match.group(1).capitalize()
            base_name = f"Claude {tier} {version}"
        else:
            base_name = " ".join(
                [w.capitalize() if w.islower() else w for w in base_name.split("-")]
            )
    else:
        replacements = {
            "gpt-4o-mini": "GPT-4o mini",
            "gpt-4o": "GPT-4o",
            "gpt-4": "GPT-4",
            "o1": "o1",
            "o3": "o3",
        }
        for old, new in replacements.items():
            if base_name.startswith(old):
                base_name = base_name.replace(old, new)
                break
        base_name = " ".join(
            [w.capitalize() if w.islower() else w for w in base_name.split("-")]
        )

    if date_str:
        return f"{base_name} ({date_str})"
    return base_name


# ─── Middleware ─────────────────────────────────────────────────────────────
@app.before_request
def ensure_user_session():
    """Assigns a unique ID to every visitor to isolate their UI settings."""
    if "user_id" not in session:
        user_id = str(uuid.uuid4())
        session["user_id"] = user_id
        session.permanent = True  # Make the session cookie long-lasting
        # Create a corresponding user in the database
        new_user = User(id=user_id)
        db.session.add(new_user)
        db.session.commit()


@app.before_request
def redirect_to_http():
    if request.is_secure and "localhost" in request.host:
        url = request.url.replace("https://", "http://", 1)
        return redirect(url, code=301)


@app.after_request
def disable_hsts(response):
    response.headers["Strict-Transport-Security"] = "max-age=0; includeSubDomains"
    return response


# ─── Routes ─────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_file("competitor-research.html")


@app.route("/api/settings", methods=["GET", "POST"])
def handle_settings():
    uid = session["user_id"]

    user_settings = UserSettings.query.filter_by(user_id=uid).first()

    if not user_settings:
        # --- MIGRATION BLOCK: Check for old file data ---
        old_cols, old_presets = [], {}
        if os.path.exists("settings.json"):
            try:
                with open("settings.json", "r") as f:
                    old_data = json.load(f)
                    old_cols = old_data.get("columns", [])
                    old_presets = old_data.get("presets", {})
            except Exception:
                pass
        # --- END MIGRATION ---

        user_settings = UserSettings(user_id=uid, columns=old_cols, presets=old_presets)
        db.session.add(user_settings)
        db.session.commit()

    # Handle the saving of new settings/presets
    if request.method == "POST":
        data = request.json
        user_settings.columns = data.get("columns", [])
        user_settings.presets = data.get("presets", {})

        # Explicitly tell SQLAlchemy the JSON has changed
        flag_modified(user_settings, "columns")
        flag_modified(user_settings, "presets")

        db.session.commit()
        return jsonify({"status": "success"})

    return jsonify({"columns": user_settings.columns, "presets": user_settings.presets})


@app.route("/api/comparisons", methods=["GET", "POST"])
def handle_comparisons():
    """Handles comparison data globally for all users as discrete events."""
    uid = session["user_id"]

    if request.method == "POST":
        req_data = request.json or {}
        metadata = req_data.get("metadata", {})
        new_data = req_data.get("comparisons", req_data)
        companies = list(new_data.keys())

        if len(companies) == 2:
            comp_a, comp_b = companies[0], companies[1]

            for comp_name in [comp_a, comp_b]:
                if comp_name in metadata:
                    info = CompanyInfo.query.get(comp_name)
                    if not info:
                        info = CompanyInfo(name=comp_name)
                        db.session.add(info)
                    info.region = metadata[comp_name].get("region", "RoW")
                    info.category = metadata[comp_name].get(
                        "category", "Generalist Dev Agency"
                    )

            def calculate_score(cat_data):
                score = 0
                for cat in cat_data:
                    for p in cat.get("positives", []):
                        score += abs(int(p.get("impact_score", 1)))
                    for l in cat.get("landmines", []):
                        score -= abs(int(l.get("severity_score", 1)))
                return score

            score_a = calculate_score(new_data[comp_a])
            score_b = calculate_score(new_data[comp_b])

            event_a = Comparison(
                user_id=uid,
                company_name=comp_a,
                opponent_name=comp_b,
                net_score=(score_a - score_b),
                timestamp=time.time(),
                data=new_data[comp_a],
            )
            db.session.add(event_a)

            event_b = Comparison(
                user_id=uid,
                company_name=comp_b,
                opponent_name=comp_a,
                net_score=(score_b - score_a),
                timestamp=time.time(),
                data=new_data[comp_b],
            )
            db.session.add(event_b)

        db.session.commit()
        return jsonify({"status": "success"})

    comparisons = Comparison.query.all()  # Admin dashboard shows all comparisons
    result = {}
    for c in comparisons:
        if c.company_name not in result:
            result[c.company_name] = []
        result[c.company_name].append(
            {
                "id": c.id,
                "opponent_name": c.opponent_name,
                "net_score": c.net_score,
                "timestamp": c.timestamp,
                "data": c.data,
            }
        )
    return jsonify(result)


# ─── Admin Panel Endpoints ──────────────────────────────────────────────────
def is_admin_authenticated():
    return session.get("is_admin", False)


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    password = request.json.get("password")
    admin_password_env = os.environ.get("ADMIN_PASSWORD")

    if not admin_password_env:
        return jsonify({"error": "ADMIN_PASSWORD not set in .env"}), 400

    if password == admin_password_env:
        session["is_admin"] = True
        return jsonify({"status": "success", "message": "Admin logged in"})
    else:
        session["is_admin"] = False
        return jsonify({"error": "Invalid admin password"}), 401


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    if is_admin_authenticated():
        session["is_admin"] = False
        return jsonify({"status": "success", "message": "Admin panel locked"})
    return jsonify({"error": "Not logged in as admin"}), 400


@app.route("/api/admin/api_keys", methods=["GET", "POST", "DELETE"])
def admin_api_keys():
    """Allows an admin to manage the global API keys."""
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    settings = GlobalSettings.query.get(1)
    if not settings:
        settings = GlobalSettings(id=1)
        db.session.add(settings)
        db.session.commit()

    if request.method == "GET":
        return jsonify(
            {
                "openai_key_set": bool(settings.encrypted_openai_key),
                "anthropic_key_set": bool(settings.encrypted_anthropic_key),
            }
        )

    elif request.method == "POST":
        data = request.json
        openai_key = data.get("openai_key")
        anthropic_key = data.get("anthropic_key")

        if not fernet:
            return jsonify({"error": "ENCRYPTION_KEY not set on server."}), 500

        if openai_key:
            settings.encrypted_openai_key = encrypt_key(openai_key)
        if anthropic_key:
            settings.encrypted_anthropic_key = encrypt_key(anthropic_key)
        db.session.commit()
        return jsonify({"status": "success", "message": "Global API keys updated"})

    elif request.method == "DELETE":
        data = request.json
        provider = data.get("provider")

        if provider == "openai":
            settings.encrypted_openai_key = None
        elif provider == "anthropic":
            settings.encrypted_anthropic_key = None
        else:
            return jsonify({"error": "Invalid provider specified"}), 400

        db.session.commit()
        return jsonify(
            {
                "status": "success",
                "message": f"Global {provider.capitalize()} API key deleted",
            }
        )


@app.route("/api/admin/comparisons", methods=["GET", "DELETE"])
def admin_comparisons():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    if request.method == "GET":
        comparisons = Comparison.query.all()
        return jsonify(
            [
                {
                    "id": c.id,
                    "user_id": c.user_id,
                    "company_name": c.company_name,
                    "opponent_name": c.opponent_name,
                    "net_score": c.net_score,
                    "timestamp": c.timestamp,
                }
                for c in comparisons
            ]
        )
    elif request.method == "DELETE":
        comparison_id = request.json.get("id")
        if comparison_id:
            comparison = Comparison.query.get(comparison_id)
            if comparison:
                db.session.delete(comparison)
                db.session.commit()
                return jsonify(
                    {
                        "status": "success",
                        "message": f"Comparison {comparison_id} deleted",
                    }
                )
            return jsonify({"error": "Comparison not found"}), 404

        # If no specific ID, delete all
        db.session.query(Comparison).delete()
        db.session.commit()
        return jsonify({"status": "success", "message": "All comparisons deleted"})


@app.route("/api/summary", methods=["POST"])
def generate_executive_summary():
    data = request.json
    provider = data.get("provider", "openai")
    model = data.get("model")
    company = data.get("company")
    trends = data.get("trends")

    client = get_client(provider, session["user_id"])
    if not client:
        return (
            jsonify({"error": f"{provider.capitalize()} API Key missing or invalid."}),
            400,
        )

    schema_str = json.dumps(
        {
            "market_positioning": "string (2-3 sentences objective summary of where this company sits in the market)",
            "reasons_to_choose": [
                "string (Specific reason a buyer would select this company)"
            ],
            "reasons_to_hesitate": [
                "string (Specific reason a buyer might look for alternatives)"
            ],
        }
    )

    system_msg = f"""You are an objective, third-party market analyst. You MUST output ONLY raw JSON.
    Analyze these aggregated historical win/loss trends for {company} and create an objective, 3rd-person evaluation from a buyer's perspective.
    Do not take sides. Explain why a customer would choose them, and why a customer might avoid them.
    You must use exactly this JSON structure:
    {schema_str}"""

    try:
        if provider == "openai":
            response = client.chat.completions.create(
                model=model,
                temperature=0.2,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": f"Trends Data: {json.dumps(trends)}"},
                ],
            )
            raw_text = response.choices[0].message.content
        else:
            message = client.messages.create(
                model=model,
                temperature=0.2,
                max_tokens=2000,
                system=system_msg,
                messages=[
                    {"role": "user", "content": f"Trends Data: {json.dumps(trends)}"}
                ],
            )
            raw_text = message.content[0].text

        return jsonify(extract_json(raw_text))

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/models", methods=["GET"])
def get_models():
    current_time = time.time()
    if model_cache["data"] and (current_time - model_cache["timestamp"] < CACHE_TTL):
        return jsonify(model_cache["data"])

    models = {"openai": [], "anthropic": []}

    model_cache["data"] = models
    model_cache["timestamp"] = current_time

    # We can use the server's key for listing models, as it's not a sensitive operation
    try:
        oai_key = get_global_api_key("openai") or os.environ.get("OPENAI_API_KEY")
        if oai_key:
            client = OpenAI(api_key=oai_key)
            oai_data = client.models.list()
            chat_models = [
                m.id
                for m in oai_data
                if ("gpt-4" in m.id or "o1" in m.id or "o3" in m.id)
                and "realtime" not in m.id
                and "audio" not in m.id
            ]
            chat_models.sort(reverse=True)
            models["openai"] = [
                {"value": m, "label": format_model_label(m)} for m in chat_models
            ]
        else:
            raise ValueError("No OpenAI API key found.")
    except Exception:
        models["openai"] = [
            {"value": "gpt-4o", "label": "GPT-4o (Fallback)"},
            {"value": "gpt-4o-mini", "label": "GPT-4o mini (Fallback)"},
        ]

    try:
        ant_key = get_global_api_key("anthropic") or os.environ.get("ANTHROPIC_API_KEY")
        if ant_key:
            client = Anthropic(api_key=ant_key)
            ant_data = client.models.list()
            c_models = [m.id for m in ant_data if "claude" in m.id]
            c_models.sort(reverse=True)
            models["anthropic"] = [
                {"value": m, "label": format_model_label(m)} for m in c_models
            ]
        else:
            raise ValueError("No Anthropic API key found.")
    except Exception:
        models["anthropic"] = [
            {
                "value": "claude-3-7-sonnet-20250219",
                "label": "Claude 3.7 Sonnet (Fallback)",
            },
            {
                "value": "claude-3-5-sonnet-20241022",
                "label": "Claude 3.5 Sonnet (Fallback)",
            },
        ]

    model_cache["data"] = models
    model_cache["timestamp"] = current_time
    return jsonify(models)


@app.route("/api/research", methods=["POST"])
def research():
    data = request.json
    provider = data.get("provider", "openai")
    model = data.get("model")
    prompt = data.get("prompt")
    schema = data.get("schema")

    schema_str = json.dumps(schema) if isinstance(schema, dict) else schema

    client = get_client(provider, session["user_id"])
    if not client:
        return (
            jsonify(
                {
                    "error": f"{provider.capitalize()} API Key missing or invalid. Please set one in Settings."
                }
            ),
            400,
        )

    system_msg = f"""You are a competitive intelligence analyst. You MUST output ONLY raw JSON, with no markdown formatting. 
    The JSON schema below contains instructions in its value fields. You must REPLACE these instruction strings with the actual researched data.
    You must use exactly this JSON structure:
    {schema_str}"""

    try:
        if provider == "openai":
            response = client.chat.completions.create(
                model=model,
                temperature=0.0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": prompt},
                ],
            )
            raw_text = response.choices[0].message.content
            total_tokens = response.usage.total_tokens
        else:
            message = client.messages.create(
                model=model,
                temperature=0.0,
                max_tokens=4000,
                system=system_msg,
                messages=[{"role": "user", "content": prompt}],
            )
            raw_text = message.content[0].text
            total_tokens = message.usage.input_tokens + message.usage.output_tokens

        parsed_data = extract_json(raw_text)
        parsed_data["_meta_usage"] = total_tokens
        return jsonify(parsed_data)

    except Exception as e:
        error_msg = str(e)
        if "401" in error_msg or "invalid_api_key" in error_msg:
            return (
                jsonify({"error": "Invalid API Key. Please check your .env file."}),
                401,
            )
        return jsonify({"error": error_msg}), 500


@app.route("/api/verify", methods=["POST"])
def verify_data():
    data = request.json
    provider = data.get("provider", "openai")
    model = data.get("model")
    prompt = data.get("prompt")
    schema = data.get("schema")
    input_data = data.get("input_data")

    schema_str = json.dumps(schema) if isinstance(schema, dict) else schema

    client = get_client(provider, session["user_id"])
    if not client:
        return (
            jsonify(
                {
                    "error": f"{provider.capitalize()} API Key missing or invalid. Please set one in Settings."
                }
            ),
            400,
        )

    system_msg = f"""You are an expert data verification analyst. You MUST output ONLY raw JSON.

    INSTRUCTION ON CATEGORICAL INTEGRITY:
    1. First, analyze each column to see if the user is using a specific tagging pattern or a limited set of terms (e.g., 'RoW', 'EU', 'DACH').
    2. If a pattern is detected, do NOT 'correct' a value if it logically fits into that existing term, even if a more specific factual value exists (e.g., if the column uses 'RoW', do not change 'RoW' to 'USA').
    3. Only correct a value if it is fundamentally false (e.g., a company listed in 'Nordics' that is actually based in 'Africa').
    4. If the original data is blank, research the company and fill it using the detected category pattern.

    You must use exactly this JSON structure:
    {schema_str}"""

    user_content = f"Input Data to Verify:\n{input_data}\n\nInstructions:\n{prompt}"

    try:
        if provider == "openai":
            response = client.chat.completions.create(
                model=model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_content},
                ],
            )
            raw_text = response.choices[0].message.content
            total_tokens = response.usage.total_tokens
        else:
            message = client.messages.create(
                model=model,
                max_tokens=4000,
                system=system_msg,
                messages=[{"role": "user", "content": user_content}],
            )
            raw_text = message.content[0].text
            total_tokens = message.usage.input_tokens + message.usage.output_tokens

        parsed_data = extract_json(raw_text)
        parsed_data["_meta_usage"] = total_tokens
        return jsonify(parsed_data)

    except Exception as e:
        error_msg = str(e)
        if "401" in error_msg or "invalid_api_key" in error_msg:
            return (
                jsonify({"error": "Invalid API Key. Check the key in your .env file."}),
                401,
            )
        return jsonify({"error": error_msg}), 500


def find_free_port(start_port):
    port = start_port
    while port < start_port + 10:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
            port += 1
    return start_port


if __name__ == "__main__":
    port = int(os.environ.get("APP_PORT", 3030))
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        port = find_free_port(3030)
        os.environ["APP_PORT"] = str(port)

    print(f"Server running at http://0.0.0.0:{port}")
    # Bound to 0.0.0.0 to accept external network traffic on servers
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=True)
