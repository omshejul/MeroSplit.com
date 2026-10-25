const fs = require('node:fs');
const path = require('node:path');
const { IOSConfig, withXcodeProject, withDangerousMod } = require('expo/config-plugins');

module.exports = config => {
  config = withXcodeProject(config, mod => {
    for (const name of ['OFL-StackSansText.txt', 'GoogleSans-OFL.txt']) {
      const filepath = path.relative(mod.modRequest.platformProjectRoot,
        path.join(mod.modRequest.projectRoot, 'assets/fonts', name));
      IOSConfig.XcodeUtils.ensureGroupRecursively(mod.modResults, 'Resources');
      IOSConfig.XcodeUtils.addResourceFileToGroup({ filepath, groupName: 'Resources',
        project: mod.modResults, isBuildFile: true });
    }
    return mod;
  });
  return withDangerousMod(config, ['android', mod => {
    for (const name of ['OFL-StackSansText.txt', 'GoogleSans-OFL.txt']) {
      const destination = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/assets/licenses', name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(mod.modRequest.projectRoot, 'assets/fonts', name), destination);
    }
    return mod;
  }]);
};
