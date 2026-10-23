const path = require('node:path');
const fs = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../../fixtures')];
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, 'wasm'])];
// Node regression tests import explicit .ts files. Honor their browser siblings
// too, so the same pure domain modules remain usable by Node and Metro.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName.startsWith('.') && /\.tsx?$/.test(moduleName)) {
    const browser = moduleName.replace(/\.(tsx?)$/, '.web.$1');
    if (fs.existsSync(path.resolve(path.dirname(context.originModulePath), browser))) moduleName = browser;
  }
  return context.resolveRequest(context, moduleName, platform);
};
const enhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const next = enhanceMiddleware ? enhanceMiddleware(middleware, server) : middleware;
  return (request, response, done) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    return next(request, response, done);
  };
};
module.exports = config;
