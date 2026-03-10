#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "--- Competitor Research Tool Setup ---"

# 1. Check for existing venv and ask to replace
if [ -d "venv" ]; then
    read -p "A virtual environment (venv) already exists. Do you want to delete and recreate it? (y/n): " confirm
    if [[ "$confirm" == [yY] || "$confirm" == [yY][eE][sS] ]]; then
        echo "Removing old venv..."
        rm -rf venv
    else
        echo "Keeping existing venv. Skipping creation..."
    fi
fi

# 2. Create the Virtual Environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating a fresh virtual environment..."
    python3 -m venv venv
fi

# 3. Install dependencies from requirements.txt
if [ -f "requirements.txt" ]; then
    echo "Installing requirements from requirements.txt..."
    ./venv/bin/pip install --upgrade pip
    ./venv/bin/pip install -r requirements.txt
else
    echo "Warning: requirements.txt not found. Skipping library installation."
fi

# 4. Handle the .env file
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "Creating .env from template (.env.example)..."
        cp .env.example .env
        echo "NOTICE: A new .env file was created. Please add your API keys to it."
    else
        echo "NOTICE: No .env or .env.example found. You will need to create one manually."
    fi
fi

echo "--------------------------------------"
echo "✅ Setup complete! No errors encountered."
echo "Run 'source venv/bin/activate' to start your environment."
echo "--------------------------------------"