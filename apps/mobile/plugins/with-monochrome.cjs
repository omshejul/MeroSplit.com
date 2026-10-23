const { AndroidConfig, withAndroidColors, withAndroidColorsNight, withAndroidStyles, withAppDelegate } = require('expo/config-plugins');

module.exports = config => {
  const accent = (value) => mod => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: 'merosplit_accent', value });
    return mod;
  };
  config = withAndroidColors(config, accent('#075DB4'));
  config = withAndroidColorsNight(config, accent('#83B9FF'));
  config = withAndroidStyles(config, mod => {
    mod.modResults = AndroidConfig.Styles.assignStylesValue(mod.modResults, {
      add: true, parent: AndroidConfig.Styles.getAppThemeGroup(), name: 'colorAccent', value: '@color/merosplit_accent',
    });
    return mod;
  });
  return withAppDelegate(config, mod => {
    const anchor = '  var window: UIWindow?';
    // Expo's scene delegate creates this window and forwards activation here.
    const activation = `  public override func applicationDidBecomeActive(_ application: UIApplication) {
    super.applicationDidBecomeActive(application)
    window?.tintColor = .systemBlue
  }`;
    mod.modResults.contents = mod.modResults.contents.replace(activation.replace('.systemBlue', '.label'), activation);
    if (!mod.modResults.contents.includes(activation)) {
      if (!mod.modResults.contents.includes(anchor) || mod.modResults.contents.includes('func applicationDidBecomeActive(')) {
        throw new Error('Check the AppDelegate activation hook before applying its monochrome tint.');
      }
      mod.modResults.contents = mod.modResults.contents.replace(anchor, `${anchor}\n\n${activation}`);
    }
    if (!mod.modResults.contents.includes('import UIKit')) mod.modResults.contents = `import UIKit\n${mod.modResults.contents}`;
    return mod;
  });
};
