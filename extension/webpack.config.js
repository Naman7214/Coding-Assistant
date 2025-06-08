const path = require('path');

const config = {
  target: 'node',
  entry: './src/extension_streaming.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension_streaming.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode',
    // Exclude native dependencies that cause webpack issues
    'onnxruntime-node': 'commonjs2 onnxruntime-node',
    'sharp': 'commonjs2 sharp',
    '@img/sharp-libvips-dev': 'commonjs2 @img/sharp-libvips-dev',
    '@img/sharp-wasm32': 'commonjs2 @img/sharp-wasm32',
    // Exclude chonkie and its dependencies that cause bundling issues
    'chonkie': 'commonjs2 chonkie',
    '@xenova/transformers': 'commonjs2 @xenova/transformers'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  }
};

module.exports = config; 