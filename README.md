# Competitor Research Tool (v0.2)
A specialized competitive intelligence analyst tool that leverages Large Language Models (LLMs) to research and map the landscape of any company or product. It dynamically generates structured data based on custom-defined columns and exports results to professional formats.

## Installation
To get this project running on your local machine, follow these steps:

### Clone the repository
git clone <your-repo-url>
cd <your-project-directory>

### Make the setup script executable
chmod +x setup.sh

### Run the automated setup
1. run ./setup.sh

2. Configure API Keys
The setup script creates a .env file based on the template. Open it and add your credentials:

OpenAI API Key: Required for GPT models.
Anthropic API Key: Required for Claude models.

3. Run the Tool

### Activate the environment
source venv/bin/activate

### Launch the Flask server
python app.py
Visit http://127.0.0.1:3030 in your browser.

# 🛠 Features
Dynamic Column Builder: Define specific data points (e.g., Pricing, Size, Tech Stack) for the AI to find.

Multi-Provider Support: Switch between OpenAI (GPT-4o, o1, o3) and Anthropic (Claude 3.7/3.5) dynamically.

Custom Research Prompts: Advanced mode allows users to override the base prompt while maintaining the data schema.

Export to Excel: One-click generation of formatted .xlsx reports for research documentation.
