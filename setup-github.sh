#!/usr/bin/env bash
# Puts this folder on GitHub as a private repository (needs git and the GitHub CLI: https://cli.github.com/)
cd "$(dirname "$0")"
command -v git >/dev/null || { echo "Install git first."; exit 1; }
command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com/"; exit 1; }
git config user.email >/dev/null || { echo 'Run: git config --global user.name "Your Name" && git config --global user.email "you@example.com"'; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login
[ -d .git ] || git init -b main
git add -A
git commit -m "Guild Hall"
read -r -p "Name for the new private repository [guild-hall]: " REPO
gh repo create "${REPO:-guild-hall}" --private --source=. --remote=origin --push
echo "Done. Open the repository on GitHub and look at the Actions tab."
