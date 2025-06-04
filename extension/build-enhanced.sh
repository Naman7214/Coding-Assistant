#!/bin/bash

# Enhanced Assistant Sidebar Build Script
# This script builds the enhanced extension with TRUE streaming support

echo "🚀 Building Enhanced Assistant Sidebar Extension with TRUE Streaming..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the assistant-sidebar directory."
    exit 1
fi

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf out/
rm -rf node_modules/.cache/
rm -f *.vsix

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Copy enhanced package.json for building
echo "📋 Setting up enhanced configuration..."
cp package-enhanced.json package.json.bak
cp package-enhanced.json package.json

# Compile TypeScript
echo "🔨 Compiling TypeScript..."
npx tsc --project tsconfig.json

# Check if compilation was successful
if [ $? -ne 0 ]; then
    echo "❌ TypeScript compilation failed!"
    # Restore original package.json
    mv package.json.bak package.json
    exit 1
fi

# Build with enhanced webpack configuration
echo "📦 Building with enhanced webpack configuration..."
npx webpack --config webpack.enhanced.config.js

# Check if webpack build was successful
if [ $? -ne 0 ]; then
    echo "❌ Enhanced webpack build failed!"
    # Restore original package.json
    mv package.json.bak package.json
    exit 1
fi

# Package the extension
echo "📦 Packaging enhanced extension..."
npx vsce package --out enhanced-assistant-sidebar.vsix

# Check if packaging was successful
if [ $? -eq 0 ]; then
    echo "✅ Enhanced extension built successfully!"
    echo "📁 Output: enhanced-assistant-sidebar.vsix"
    echo ""
    echo "🎯 Features included:"
    echo "   • TRUE real-time streaming from agent_streaming_api_v2.py"
    echo "   • Live thinking visualization with character count"
    echo "   • Tool selection and execution tracking"
    echo "   • Tool arguments display in JSON format"
    echo "   • Permission handling UI with grant/deny buttons"
    echo "   • Enhanced logging and debugging"
    echo "   • State management and export functionality"
    echo "   • Real-time status updates in status bar"
    echo "   • Detailed event tracking and timestamps"
    echo ""
    echo "🚀 To install:"
    echo "   code --install-extension enhanced-assistant-sidebar.vsix"
    echo ""
    echo "🔧 To start the TRUE streaming server:"
    echo "   cd system/coding_agent && python3 agent_streaming_api_v2.py"
    echo ""
    echo "🎮 Usage:"
    echo "   1. Start the TRUE streaming server"
    echo "   2. Install and activate the enhanced extension"
    echo "   3. Open the Enhanced Assistant sidebar"
    echo "   4. Ask questions and watch the TRUE streaming in action!"
    echo ""
    echo "🔍 Key differences from fake streaming:"
    echo "   • Real-time token-by-token streaming"
    echo "   • Live thinking process visualization"
    echo "   • Tool execution progress tracking"
    echo "   • Immediate permission requests"
    echo "   • No artificial delays or buffering"
else
    echo "❌ Extension packaging failed!"
    # Restore original package.json
    mv package.json.bak package.json
    exit 1
fi

# Restore original package.json
echo "🔄 Restoring original configuration..."
mv package.json.bak package.json

echo "✨ Enhanced TRUE streaming extension build complete!" 