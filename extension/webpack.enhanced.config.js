const path = require('path');

const config = {
  target: 'node',
  mode: 'production',
  entry: './src/extension_streaming.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension_streaming.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode'
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
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                module: 'es6'
              }
            }
          }
        ]
      }
    ]
  },
  optimization: {
    minimize: true
  }
};

module.exports = config; 