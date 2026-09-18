const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@aws-sdk/client-cognito-identity") {
    const packageJson = require.resolve(
      "@aws-sdk/client-cognito-identity/package.json"
    );

    return context.resolveRequest(
      context,
      path.join(path.dirname(packageJson), "dist-es", "index.js"),
      platform
    );
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;