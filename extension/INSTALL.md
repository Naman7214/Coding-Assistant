# Installation Guide

## Development Installation

### Prerequisites

- Node.js (v14 or higher)
- npm (v7 or higher)
- VS Code (v1.77.0 or higher)

### Step 1: Clone the Repository

```bash
git clone https://github.com/yourusername/assistant-sidebar.git
cd assistant-sidebar
```

### Step 2: Install Dependencies

Install dependencies for the main extension:

```bash
npm install
```

Install dependencies for the React webview UI:

```bash
cd webview-ui
npm install
cd ..
```

### Step 3: Build the Extension

Build the React webview UI first:

```bash
npm run build-webview
```

Then build the main extension:

```bash
npm run compile
```

### Step 4: Run the Extension

You can run the extension in development mode by pressing F5 in VS Code or by selecting "Run Extension" from the Run menu.

## Building a VSIX Package

To build a VSIX package for distribution:

1. Install vsce:

```bash
npm install -g @vscode/vsce
```

2. Package the extension:

```bash
vsce package
```

This will create a `.vsix` file in the root directory.

## Installing the VSIX Package

To install the extension from the VSIX file:

1. Open VS Code
2. Go to the Extensions view (Ctrl+Shift+X)
3. Click on the "..." at the top of the Extensions view
4. Select "Install from VSIX..."
5. Navigate to and select the `.vsix` file

## Troubleshooting

If you encounter any issues:

1. Check the VS Code Developer Tools (Help > Toggle Developer Tools) for console errors
2. Ensure all dependencies are installed correctly
3. Make sure the agent API server is running on port 5000
4. Check the VS Code output panel for extension logs 