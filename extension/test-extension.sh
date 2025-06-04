#!/bin/bash

# Extension Test Script
echo "🚀 Testing VS Code Extension Initialization..."

# Check if we're in the extension directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Please run this script from the extension directory"
    exit 1
fi

echo "📁 Current directory: $(pwd)"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Compile the extension
echo "🔨 Compiling extension..."
npm run compile

if [ $? -eq 0 ]; then
    echo "✅ Extension compiled successfully"
else
    echo "❌ Extension compilation failed"
    exit 1
fi

# Check if the output file exists
if [ -f "out/extension_enhanced_streaming.js" ]; then
    echo "✅ Extension output file created"
else
    echo "❌ Extension output file not found"
    exit 1
fi

echo "🎉 Extension test completed successfully!"
echo ""
echo "📋 To test in VS Code:"
echo "1. Open VS Code"
echo "2. Press F5 to start debugging"
echo "3. Check the Output panel for logs"
echo "4. Look for 'Enhanced Assistant' in the sidebar"
