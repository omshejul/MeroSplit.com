const { AndroidConfig, withAndroidColors, withAndroidColorsNight, withAndroidStyles, withAppDelegate } = require('expo/config-plugins');

module.exports = config => {
  const accent = (value) => mod => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: 'merosplit_accent', value });
    return mod;
  };
  config = withAndroidColors(config, accent('#161616'));
  config = withAndroidColorsNight(config, accent('#F5F5F5'));
  config = withAndroidStyles(config, mod => {
    mod.modResults = AndroidConfig.Styles.assignStylesValue(mod.modResults, {
      add: true, parent: AndroidConfig.Styles.getAppThemeGroup(), name: 'colorAccent', value: '@color/merosplit_accent',
    });
    return mod;
  });
  return withAppDelegate(config, mod => {
    const anchor = 'window = UIWindow(frame: UIScreen.main.bounds)';
    const tint = 'window?.tintColor = UIColor { traits in traits.userInterfaceStyle == .dark ? .white : .black }';
    if (mod.modResults.contents.includes('window?.tintColor = .black')) {
      mod.modResults.contents = mod.modResults.contents.replace('window?.tintColor = .black', tint);
    } else if (!mod.modResults.contents.includes(tint)) {
      if (!mod.modResults.contents.includes(anchor)) throw new Error('Check the AppDelegate window before applying its monochrome tint.');
      mod.modResults.contents = mod.modResults.contents.replace(anchor, `${anchor}\n    ${tint}`);
    }
    return mod;
  });
};
