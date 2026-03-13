#!/bin/bash
set -e

BUMP=${1:-patch}

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: npm run release [patch|minor|major]"
  exit 1
fi

# Make sure we're on main and clean
git checkout main
git pull origin main

if [ -n "$(git status --porcelain)" ]; then
  echo "Working directory not clean. Commit or stash changes first."
  exit 1
fi

# Bump version (no git tag, we'll do that via release)
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
echo "Bumped to $NEW_VERSION"

# Branch, commit, push, PR, merge
BRANCH="release/$NEW_VERSION"
git checkout -b "$BRANCH"
git add package.json package-lock.json
git commit -m "Release $NEW_VERSION"
git push -u origin "$BRANCH"

gh pr create --title "Release $NEW_VERSION" --body "Automated version bump to $NEW_VERSION"
gh pr merge --auto --squash

# Wait for merge
echo "Waiting for PR to merge..."
while true; do
  STATE=$(gh pr view "$BRANCH" --json state --jq .state)
  if [ "$STATE" = "MERGED" ]; then
    break
  fi
  sleep 5
done

# Create release (triggers npm publish)
git checkout main
git pull origin main
gh release create "$NEW_VERSION" --title "$NEW_VERSION" --generate-notes

echo ""
echo "Released $NEW_VERSION — npm publish will run automatically."
