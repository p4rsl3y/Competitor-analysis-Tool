import os
import json
import re
import socket
import time
import uuid
from flask import Flask, request, jsonify, send_file, redirect, session
from dotenv import load_dotenv
from openai import OpenAI
from anthropic import Anthropic
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm.attributes import flag_modified

# Load keys from the .env file
load_dotenv()

app = Flask(__name__)
# Secret key is required to encrypt user sessions
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "super-secret-local-key")

# Database Configuration (Uses PostgreSQL on servers, SQLite locally)
# Heroku/Render use 'postgres://' which SQLAlchemy requires as 'postgresql://'
db_url = os.environ.get("DATABASE_URL", "sqlite:///app_data.db")
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)

# Cache for model fetching
model_cache = {"data": None, "timestamp": 0}
CACHE_TTL = 3600

clients = {"openai": None, "anthropic": None}


# ─── Database Models ────────────────────────────────────────────────────────
class UserSettings(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(50), unique=True, nullable=False)
    columns = db.Column(db.JSON, default=list)
    presets = db.Column(db.JSON, default=dict)


class Comparison(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(50), nullable=False)
    company_name = db.Column(db.String(100), nullable=False)
    data = db.Column(db.JSON, default=list)


# Initialize database
with app.app_context():
    print("Checking/Creating database...")
    db.create_all()
    print("Database initialization complete.")


# ─── Helper Functions ───────────────────────────────────────────────────────
def get_openai_client():
    if not clients["openai"]:
        api_key = os.environ.get("OPENAI_API_KEY")
        if api_key:
            clients["openai"] = OpenAI(api_key=api_key)
    return clients["openai"]


def get_anthropic_client():
    if not clients["anthropic"]:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if api_key:
            clients["anthropic"] = Anthropic(api_key=api_key)
    return clients["anthropic"]


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
    """Assigns a unique ID to every visitor to isolate their data."""
    if "user_id" not in session:
        session["user_id"] = str(uuid.uuid4())


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
    """Handles comparison data with deep merging per user session."""
    uid = session["user_id"]

    if request.method == "POST":
        new_data = request.json
        for comp_name, new_categories in new_data.items():
            comp_record = Comparison.query.filter(
                Comparison.user_id == uid,
                db.func.lower(Comparison.company_name) == comp_name.lower(),
            ).first()

            if not comp_record:
                comp_record = Comparison(user_id=uid, company_name=comp_name, data=[])
                db.session.add(comp_record)

            existing_data = comp_record.data or []
            existing_cats = {c["category"].lower(): c for c in existing_data}

            for new_cat in new_categories:
                cat_key = new_cat["category"].lower()

                if cat_key not in existing_cats:
                    existing_data.append(new_cat)
                    existing_cats[cat_key] = new_cat
                else:
                    target_cat = existing_cats[cat_key]

                    existing_pos_kws = {
                        p.get("keyword", "").lower()
                        for p in target_cat.get("positives", [])
                    }
                    for p in new_cat.get("positives", []):
                        if p.get("keyword", "").lower() not in existing_pos_kws:
                            target_cat.setdefault("positives", []).append(p)
                            existing_pos_kws.add(p.get("keyword", "").lower())

                    existing_land_kws = {
                        l.get("keyword", "").lower()
                        for l in target_cat.get("landmines", [])
                    }
                    for l in new_cat.get("landmines", []):
                        if l.get("keyword", "").lower() not in existing_land_kws:
                            target_cat.setdefault("landmines", []).append(l)
                            existing_land_kws.add(l.get("keyword", "").lower())

            comp_record.data = list(existing_data)
            flag_modified(comp_record, "data")

        db.session.commit()
        return jsonify({"status": "success"})

    comparisons = Comparison.query.filter_by(user_id=uid).all()
    result = {c.company_name: c.data for c in comparisons}
    return jsonify(result)


@app.route("/api/models", methods=["GET"])
def get_models():
    current_time = time.time()
    if model_cache["data"] and (current_time - model_cache["timestamp"] < CACHE_TTL):
        return jsonify(model_cache["data"])

    models = {"openai": [], "anthropic": []}

    try:
        client = get_openai_client()
        if client:
            oai_data = client.models.list()
            chat_models = [
                m.id
                for m in oai_data.data
                if ("gpt-4" in m.id or "o1" in m.id or "o3" in m.id)
                and "realtime" not in m.id
                and "audio" not in m.id
            ]
            chat_models.sort(reverse=True)
            models["openai"] = [
                {"value": m, "label": format_model_label(m)} for m in chat_models
            ]
    except Exception:
        models["openai"] = [
            {"value": "gpt-4o", "label": "GPT-4o (Fallback)"},
            {"value": "gpt-4o-mini", "label": "GPT-4o mini (Fallback)"},
        ]

    try:
        client = get_anthropic_client()
        if client:
            ant_data = client.models.list()
            c_models = [m.id for m in ant_data.data if "claude" in m.id]
            c_models.sort(reverse=True)
            models["anthropic"] = [
                {"value": m, "label": format_model_label(m)} for m in c_models
            ]
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

    if provider == "openai" and not get_openai_client():
        return jsonify({"error": "OpenAI API Key missing."}), 400
    if provider == "anthropic" and not get_anthropic_client():
        return jsonify({"error": "Anthropic API Key missing."}), 400

    system_msg = f"""You are a competitive intelligence analyst. You MUST output ONLY raw JSON, with no markdown formatting. 
    The JSON schema below contains instructions in its value fields. You must REPLACE these instruction strings with the actual researched data.
    You must use exactly this JSON structure:
    {schema_str}"""

    try:
        if provider == "openai":
            client = get_openai_client()
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
            client = get_anthropic_client()
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

    if provider == "openai" and not get_openai_client():
        return jsonify({"error": "OpenAI API Key missing."}), 400
    if provider == "anthropic" and not get_anthropic_client():
        return jsonify({"error": "Anthropic API Key missing."}), 400

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
            client = get_openai_client()
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
            client = get_anthropic_client()
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
