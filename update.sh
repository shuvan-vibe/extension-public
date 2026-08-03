#!/bin/bash
echo "=============================================="
echo "     FoxiGrow Extension Updater"
echo "=============================================="
echo ""
echo "Downloading latest version from GitHub..."

# Download the zip
curl -L "https://github.com/shuvan-vibe/extension-public/archive/refs/heads/main.zip" -o "update.zip"

# Extract the zip
echo "Extracting files..."
unzip -q -o update.zip -d temp_update

# Move files from the extracted folder to the current directory
echo "Updating files..."
cp -R temp_update/extension-public-main/* .

# Clean up
echo "Cleaning up..."
rm -rf temp_update
rm update.zip

echo ""
echo "Update complete!"
echo "Please go to chrome://extensions and click the 'Refresh' button on the FoxiGrow card."
echo ""
