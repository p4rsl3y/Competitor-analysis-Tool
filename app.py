import os
import json
import re
import socket
from flask import Flask, request, jsonify, send_file
from dotenv import load_dotenv
from openai import OpenAI
from anthropic import Anthropic

# Load keys from the .env file
load_dotenv()

app = Flask(__name__)
SETTINGS_FILE = 'settings.json'

def extract_json(raw_text):
    """Extracts and parses JSON from a raw LLM response."""
    cleaned = re.sub(r'```json|```', '', raw_text, flags=re.IGNORECASE).strip()
    match = re.search(r'\{[\s\S]*\}', cleaned)
    if not match:
        raise ValueError("Could not find JSON structure in response.")
    return json.loads(match.group(0))

def format_model_label(model_id):
    """Parses raw API model IDs into clean UI labels with tier preceding version."""
    date_str = ""
    base_name = model_id
    
    # Extract OpenAI format (YYYY-MM-DD)
    dash_date = re.search(r'-(\d{4}-\d{2}-\d{2})$', model_id)
    # Extract Anthropic format (YYYYMMDD)
    solid_date = re.search(r'-(\d{8})$', model_id)
    
    if dash_date:
        date_str = dash_date.group(1)
        base_name = model_id[:dash_date.start()]
    elif solid_date:
        d = solid_date.group(1)
        date_str = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        base_name = model_id[:solid_date.start()]
        
    # Reformat Claude models flexibly (supports both claude-3-5-sonnet AND claude-sonnet-4-6)
    if base_name.startswith('claude'):
        version_match = re.search(r'-(\d+(?:-\d+)?)(?:-|$)', base_name)
        tier_match = re.search(r'-(sonnet|opus|haiku)', base_name)
        
        if version_match and tier_match:
            version = version_match.group(1).replace('-', '.')
            tier = tier_match.group(1).capitalize()
            base_name = f"Claude {tier} {version}"
        else:
            base_name = " ".join([w.capitalize() if w.islower() else w for w in base_name.split('-')])
    else:
        # Handle OpenAI models
        replacements = {
            'gpt-4o-mini': 'GPT-4o mini',
            'gpt-4o': 'GPT-4o',
            'gpt-4': 'GPT-4',
            'o1': 'o1',
            'o3': 'o3'
        }
        for old, new in replacements.items():
            if base_name.startswith(old):
                base_name = base_name.replace(old, new)
                break
        
        base_name = " ".join([w.capitalize() if w.islower() else w for w in base_name.split('-')])
    
    if date_str:
        return f"{base_name} ({date_str})"
    return base_name

@app.route('/')
def index():
    """Serves the frontend HTML file."""
    return send_file('competitor-research.html')

@app.route('/api/settings', methods=['GET', 'POST'])
def handle_settings():
    """Handles saving and loading the column configurations to a local JSON file."""
    if request.method == 'POST':
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(request.json, f, indent=2)
        return jsonify({"status": "success"})
    
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE, 'r') as f:
            return jsonify(json.load(f))
            
    # Return empty defaults if the file does not exist yet
    return jsonify({"columns": [], "presets": {}})

@app.route('/api/models', methods=['GET'])
def get_models():
    """Fetches and filters available text models dynamically from the providers."""
    models = {"openai": [], "anthropic": []}

    # Fetch OpenAI Models
    try:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        oai_data = client.models.list()
        
        # Filter for standard chat completion models, ignoring audio/vision/embedding utilities
        chat_models = [
            m.id for m in oai_data.data 
            if ('gpt-4' in m.id or 'o1' in m.id or 'o3' in m.id) 
            and 'realtime' not in m.id and 'audio' not in m.id
        ]
        chat_models.sort(reverse=True)
        # Apply the new formatting function here
        models["openai"] = [{"value": m, "label": format_model_label(m)} for m in chat_models]
    except Exception:
        models["openai"] = [
            {"value": "gpt-4o", "label": "GPT-4o (Fallback)"},
            {"value": "gpt-4o-mini", "label": "GPT-4o mini (Fallback)"},
            {"value": "o3-mini", "label": "o3-mini (Fallback)"}
        ]

    # Fetch Anthropic Models
    try:
        client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        ant_data = client.models.list()
        
        c_models = [m.id for m in ant_data.data if 'claude' in m.id]
        c_models.sort(reverse=True)
        # Apply the new formatting function here
        models["anthropic"] = [{"value": m, "label": format_model_label(m)} for m in c_models]
    except Exception:
        models["anthropic"] = [
            {"value": "claude-3-7-sonnet-20250219", "label": "Claude 3.7 Sonnet (Fallback)"},
            {"value": "claude-3-5-sonnet-20241022", "label": "Claude 3.5 Sonnet (Fallback)"},
            {"value": "claude-3-5-haiku-20241022", "label": "Claude 3.5 Haiku (Fallback)"}
        ]

    return jsonify(models)

@app.route('/api/research', methods=['POST'])
def research():
    """Handles requests from the frontend and calls the AI providers."""
    data = request.json
    provider = data.get('provider', 'openai')
    
    # 1. Check for keys before proceeding
    openai_key = os.environ.get("OPENAI_API_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")

    if provider == 'openai' and not openai_key:
        return jsonify({"error": "OpenAI API Key missing. Please add OPENAI_API_KEY to your .env file."}), 400
        
    if provider == 'anthropic' and not anthropic_key:
        return jsonify({"error": "Anthropic API Key missing. Please add ANTHROPIC_API_KEY to your .env file."}), 400
    model = data.get('model')
    prompt = data.get('prompt')
    schema = data.get('schema')
    
    system_msg = f"""You are a competitive intelligence analyst. You MUST output ONLY raw JSON, with no markdown formatting. 
    The JSON schema below contains instructions in its value fields. You must REPLACE these instruction strings with the actual researched data for each company.
    You must use exactly this JSON structure:
    {schema}"""
    
    try:
        if provider == 'openai':
            client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system_msg}, {"role": "user", "content": prompt}]
            )
            raw_text = response.choices[0].message.content
        else:
            client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
            message = client.messages.create(
                model=model,
                max_tokens=2000,
                system=system_msg,
                messages=[{"role": "user", "content": prompt}]
            )
            raw_text = message.content[0].text
            
        parsed_data = extract_json(raw_text)
        return jsonify(parsed_data)
        
    except Exception as e:
        error_msg = str(e)
        
        # Intercept 401 / Authentication errors for a cleaner user experience
        if "401" in error_msg or "invalid_api_key" in error_msg or "authentication" in error_msg.lower():
            friendly_name = "OpenAI" if provider == 'openai' else "Anthropic"
            return jsonify({
                "error": f"Invalid {friendly_name} API Key. Please check the key in your .env file and ensure it is copied correctly."
            }), 401
            
        return jsonify({"error": error_msg, "raw_response": raw_text if 'raw_text' in locals() else None}), 500

def find_free_port(start_port):
    """Checks for the next available port starting from start_port."""
    port = start_port
    while port < start_port + 10:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
            port += 1
    return start_port

if __name__ == '__main__':
    import os
    # Only calculate the port once to prevent the reloader from hopping
    port = int(os.environ.get("APP_PORT", 3030))
    
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        port = find_free_port(3030)
        os.environ["APP_PORT"] = str(port)

    print(f"🚀 Server running at http://127.0.0.1:{port}")
    app.run(host='127.0.0.1', port=port, debug=True)