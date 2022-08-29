import type { FeatureFlags } from '../../../feature_flags'

export const enum ModuleFormat {
  COMMONJS = 'cjs',
  ESM = 'esm',
}

export const enum ModuleFileExtensions {
  CJS = '.cjs',
  JS = '.js',
  MJS = '.mjs',
}

export const getFileExtensionForFormat = (
  moduleFormat: ModuleFormat,
  featureFlags: FeatureFlags,
): ModuleFileExtensions => {
  if (!featureFlags.zisi_output_cjs_extension) {
    return ModuleFileExtensions.JS
  }

  if (moduleFormat === ModuleFormat.COMMONJS) {
    return ModuleFileExtensions.CJS
  }

  return ModuleFileExtensions.MJS
}
