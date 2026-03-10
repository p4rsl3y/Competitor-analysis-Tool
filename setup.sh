#!/bin/bash

# 1. Create the Virtual Environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# 2. Install dependencies
echo "Installing requirements..."
./venv/bin/pip install -r requirements.txt

# 3. Handle the .env file
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "Creating .env from template..."
        cp .env.example .env
        echo "IMPORTANT: Please edit .env and add your API keys."
    else
        echo "No .env.example found. Creating blank .env..."
        touch .env
    fi
fi

echo "Setup complete. Run 'source venv/bin/activate' to start."