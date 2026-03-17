# Competitor Research Tool (v0.4)
A specialized competitive intelligence analyst tool that leverages Large Language Models (LLMs) to research and map the landscape of any company or product. It dynamically generates structured data based on custom-defined columns and exports results to professional formats.

Your erperience and results may vary greatly on the AI model used, I've personally gotten great results with Claude Sonnet.

### Requirements
Python3

OpenAI or Anthropic api key

## Installation
To get this project running on your local machine, follow these steps:

### Clone the repository
```
git clone <https://github.com/p4rsl3y/Competitor-analysis-Tool-.git>
```

### Make the setup script executable and run it
1. Run this commands in your terminal
```
./setup.sh
```

    If the command does not run the setup file run this command and try again.
    ```
    cd competitor-analysis-tool
    chmod +x setup.sh
    ```

2. Configure Environment
The setup script creates a `.env` file from the `.env.example` template. This file is essential for security and application configuration.

*   `ADMIN_PASSWORD`: Set a secure password to access the Admin Panel in the Settings tab.
*   `ENCRYPTION_KEY`: This is used to secure the API keys in the database. If this key is missing or invalid when you first run the app, the application will **fail to start** and will **print a new, valid key to your console**. Copy this new key into your `.env` file to fix the issue.
*   `FLASK_SECRET_KEY`: A secret key for securing user sessions. It's recommended to set this to a long, random string for better security, though the app will function without it.

> **Note:** API keys for OpenAI and Anthropic are no longer set in this file. They are now managed globally within the application via the **Admin Panel** in the Settings tab.


### Activate the environment
```
source venv/bin/activate
```
### Launch the Flask server
```
python3 app.py
```
Visit <http://127.0.0.1:3030> in your browser.

# Features
Dynamic Column Builder: Define specific data points (e.g., Pricing, Size, Tech Stack) for the AI to find.

Multi-Provider Support: Switch between OpenAI (GPT-4o, o1, o3) and Anthropic (Claude 3.7/3.5) dynamically.

Custom Research Prompts: Advanced mode allows users to override the base prompt while maintaining the data schema.

Export to Excel: One-click generation of formatted .xlsx reports for research documentation.

Load competitor lists from excel filetypes to compare and analyse old data

1 on 1 comparison between companies on user defined categories

User dashboard to analyse previous 1 on 1 comparisons with an executive summary.
