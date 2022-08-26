import type { FeatureFlags } from '../../../feature_flags'

export const enum ModuleFormat {
  COMMONJS = 'cjs',
  ESM = 'esm',
}

export const getFileExtensionForFormat = (moduleFormat: ModuleFormat, featureFlags: FeatureFlags): string => {
  if (!featureFlags.zisi_output_cjs_extension) {
    return '.js'
  }

  if (moduleFormat === ModuleFormat.COMMONJS) {
    return '.cjs'
  }

  return '.mjs'
}
