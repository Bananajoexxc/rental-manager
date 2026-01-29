# GitHub Repository Setup Guide

This guide will help you push the Rental Manager service to GitHub.

## Prerequisites

- Git installed locally
- GitHub account (Bananajoexxc)
- GitHub CLI (optional, for easier setup)

## Option 1: Using GitHub CLI (Recommended)

### Install GitHub CLI

**On Ubuntu/Debian:**
```bash
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh
```

**On macOS:**
```bash
brew install gh
```

### Create and Push Repository

```bash
# Navigate to the project directory
cd /home/ubuntu/rental_manager/nodejs_space

# Authenticate with GitHub
gh auth login
# Follow the prompts and select:
# - GitHub.com
# - HTTPS
# - Login with a web browser

# Initialize git repository
git init

# Add all files
git add .

# Create initial commit
git commit -m "Initial commit: Rental Manager headless service

Features:
- Automated Hygglo rental tracking
- AI-powered image analysis for item extraction
- Adaptive scheduling (1min -> 5min when inactive)
- PostgreSQL database with Prisma ORM
- Docker deployment support
- Comprehensive logging"

# Create GitHub repository and push
gh repo create rental-manager --public --source=. --remote=origin --push

# View your repository
gh repo view --web
```

## Option 2: Manual Setup (GitHub Web Interface)

### Step 1: Create Repository on GitHub

1. Go to https://github.com/new
2. **Repository name**: `rental-manager`
3. **Description**: "Headless NestJS service for automated Hygglo rental tracking with AI-powered item extraction"
4. **Visibility**: Public (or Private if preferred)
5. **Do NOT** initialize with README, .gitignore, or license (we already have these)
6. Click **Create repository**

### Step 2: Push Local Code to GitHub

```bash
# Navigate to the project directory
cd /home/ubuntu/rental_manager/nodejs_space

# Initialize git repository
git init

# Add all files
git add .

# Create initial commit
git commit -m "Initial commit: Rental Manager headless service

Features:
- Automated Hygglo rental tracking
- AI-powered image analysis for item extraction
- Adaptive scheduling (1min -> 5min when inactive)
- PostgreSQL database with Prisma ORM
- Docker deployment support
- Comprehensive logging"

# Add remote repository (replace Bananajoexxc with your username if different)
git remote add origin https://github.com/Bananajoexxc/rental-manager.git

# Push to GitHub
git push -u origin main
```

If prompted for credentials, use:
- **Username**: Bananajoexxc
- **Password**: Use a **Personal Access Token** (not your password)

### Step 3: Generate Personal Access Token (if needed)

1. Go to https://github.com/settings/tokens
2. Click **Generate new token** → **Generate new token (classic)**
3. **Note**: "Rental Manager deployment"
4. **Expiration**: 90 days (or your preference)
5. **Select scopes**:
   - ✅ `repo` (Full control of private repositories)
6. Click **Generate token**
7. **Copy the token** (you won't see it again!)
8. Use this token as your password when pushing to GitHub

## Option 3: Using SSH Keys

### Generate SSH Key

```bash
# Generate new SSH key
ssh-keygen -t ed25519 -C "your_email@example.com"

# Start SSH agent
eval "$(ssh-agent -s)"

# Add SSH key to agent
ssh-add ~/.ssh/id_ed25519

# Copy public key to clipboard
cat ~/.ssh/id_ed25519.pub
```

### Add SSH Key to GitHub

1. Go to https://github.com/settings/keys
2. Click **New SSH key**
3. **Title**: "Rental Manager Deployment Server"
4. **Key**: Paste your public key
5. Click **Add SSH key**

### Push Using SSH

```bash
cd /home/ubuntu/rental_manager/nodejs_space
git init
git add .
git commit -m "Initial commit: Rental Manager headless service"
git remote add origin git@github.com:Bananajoexxc/rental-manager.git
git push -u origin main
```

## Post-Push Configuration

### Add Repository Topics

1. Go to your repository: https://github.com/Bananajoexxc/rental-manager
2. Click the gear icon next to "About"
3. Add topics:
   - `nestjs`
   - `typescript`
   - `automation`
   - `playwright`
   - `docker`
   - `rental-management`
   - `hygglo`
   - `image-analysis`
   - `prisma`

### Add Repository Description

In the same "About" section:
**Description**: "Headless NestJS service for automated Hygglo rental tracking with AI-powered item extraction"

### Enable GitHub Actions (Optional)

If you want CI/CD:

1. Create `.github/workflows/docker-build.yml`
2. Set up automated Docker builds on push
3. Configure secrets for deployment

## Verify Setup

Check your repository is live:
```bash
# View repository in browser
gh repo view --web

# Or visit directly
open https://github.com/Bananajoexxc/rental-manager
```

## Common Issues

### Authentication Failed

**Solution**: Use a Personal Access Token instead of your password

### Permission Denied (publickey)

**Solution**: Add your SSH key to GitHub (see SSH setup above)

### Repository Already Exists

**Solution**: 
```bash
git remote set-url origin https://github.com/Bananajoexxc/rental-manager.git
git push -u origin main
```

## Next Steps

1. **Update README**: Add your email address in the Support section
2. **Add License**: Choose MIT, Apache 2.0, or your preferred license
3. **Configure Security**: Review security advisories and enable Dependabot
4. **Add Collaborators**: Invite team members if needed
5. **Create Issues**: Track features and bugs
6. **Set up Projects**: Organize work with GitHub Projects

---

**Need Help?** Check GitHub's documentation at https://docs.github.com
