#!/bin/bash
# DSPy Optimizer Setup Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Setting up DSPy Prompt Optimizer..."

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is required but not installed"
    exit 1
fi

echo "Python 3 found: $(python3 --version)"

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
CC=gcc pip install -r requirements.txt

echo "DSPy Optimizer setup complete!"
echo ""
echo "To start the service:"
echo "  cd $SCRIPT_DIR"
echo "  source venv/bin/activate"
echo "  python app.py"
echo ""
echo "The service will run on http://localhost:5000"
