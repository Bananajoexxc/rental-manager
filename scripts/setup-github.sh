#!/bin/bash

# GitHub Repository Setup Script
# This script automates the process of setting up the GitHub repository

set -e

echo "🚀 Rental Manager - GitHub Repository Setup"
echo "==========================================="
echo ""

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "❌ Git is not installed. Please install git first."
    exit 1
fi

echo "✅ Git is installed"

# Check if already in a git repository
if [ -d .git ]; then
    echo "⚠️  Git repository already initialized"
    read -p "Do you want to continue? This will add and commit all changes. (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "📦 Initializing git repository..."
    git init
    echo "✅ Git repository initialized"
fi

# Check for GitHub CLI
if command -v gh &> /dev/null; then
    echo "✅ GitHub CLI is installed"
    
    # Check if authenticated
    if gh auth status &> /dev/null; then
        echo "✅ Already authenticated with GitHub"
    else
        echo "🔐 Authenticating with GitHub..."
        gh auth login
    fi
    
    USE_GH_CLI=true
else
    echo "⚠️  GitHub CLI not found. Will use manual setup."
    echo "   Install GitHub CLI for easier setup: https://cli.github.com"
    USE_GH_CLI=false
fi

echo ""
echo "📝 Adding files to git..."
git add .

echo ""
echo "💬 Creating commit..."
git commit -m "Initial commit: Rental Manager headless service

Features:
- Automated Hygglo rental tracking
- AI-powered image analysis for item extraction
- Adaptive scheduling (1min -> 5min when inactive)
- PostgreSQL database with Prisma ORM
- Docker deployment support
- Comprehensive logging" || echo "⚠️  No changes to commit or already committed"

if [ "$USE_GH_CLI" = true ]; then
    echo ""
    echo "🌐 Creating GitHub repository..."
    
    # Check if repository already exists
    if gh repo view Bananajoexxc/rental-manager &> /dev/null; then
        echo "⚠️  Repository already exists on GitHub"
        read -p "Do you want to push to the existing repository? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git remote add origin https://github.com/Bananajoexxc/rental-manager.git 2>/dev/null || git remote set-url origin https://github.com/Bananajoexxc/rental-manager.git
            git push -u origin main
        fi
    else
        gh repo create rental-manager --public --source=. --remote=origin --push
        echo "✅ Repository created and pushed to GitHub!"
        echo ""
        echo "🎉 Your repository is live at: https://github.com/Bananajoexxc/rental-manager"
        
        # Open in browser
        read -p "Open repository in browser? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            gh repo view --web
        fi
    fi
else
    echo ""
    echo "📋 Manual Setup Instructions:"
    echo "============================="
    echo ""
    echo "1. Create a new repository on GitHub:"
    echo "   https://github.com/new"
    echo ""
    echo "2. Repository name: rental-manager"
    echo "   Description: Headless NestJS service for automated Hygglo rental tracking"
    echo "   Visibility: Public (or Private)"
    echo "   Do NOT initialize with README, .gitignore, or license"
    echo ""
    echo "3. After creating the repository, run:"
    echo ""
    echo "   git remote add origin https://github.com/Bananajoexxc/rental-manager.git"
    echo "   git branch -M main"
    echo "   git push -u origin main"
    echo ""
    echo "4. Use a Personal Access Token as your password when pushing"
    echo "   Generate one at: https://github.com/settings/tokens"
    echo ""
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "📚 Next steps:"
echo "  1. Update README.md with your email address"
echo "  2. Add repository topics on GitHub"
echo "  3. Configure deployment secrets"
echo "  4. Start developing!"
echo ""
