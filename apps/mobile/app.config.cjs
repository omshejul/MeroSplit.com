module.exports = ({ config }) => process.env.EXPO_WEB_BUILD === '1' ? {
  ...config,
  web: { ...config.web, bundler: 'metro', output: 'single' },
  experiments: { ...config.experiments, baseUrl: '/app' },
} : config;
