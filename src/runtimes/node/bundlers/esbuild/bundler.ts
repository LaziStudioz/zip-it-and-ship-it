import { basename, dirname, extname, resolve, join } from 'path'

import { build, Metafile } from '@netlify/esbuild'
import { tmpName } from 'tmp-promise'

import type { FunctionConfig } from '../../../../config.js'
import { FeatureFlags } from '../../../../feature_flags.js'
import { FunctionBundlingUserError } from '../../../../utils/error.js'
import { getPathWithExtension, safeUnlink } from '../../../../utils/fs.js'
import { RuntimeType } from '../../../runtime.js'
import { NodeBundlerType } from '../types.js'

import { getBundlerTarget, getModuleFormat } from './bundler_target.js'
import { getDynamicImportsPlugin } from './plugin_dynamic_imports.js'
import { getNativeModulesPlugin } from './plugin_native_modules.js'
import { getNodeBuiltinPlugin } from './plugin_node_builtin.js'

// Maximum number of log messages that an esbuild instance will produce. This
// limit is important to avoid out-of-memory errors due to too much data being
// sent in the Go<>Node IPC channel.
export const ESBUILD_LOG_LIMIT = 10

// When resolving imports with no extension (e.g. require('./foo')), these are
// the extensions that esbuild will look for, in this order.
const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json']

// eslint-disable-next-line max-statements
export const bundleJsFile = async function ({
  additionalModulePaths,
  basePath,
  config,
  externalModules = [],
  featureFlags,
  ignoredModules = [],
  name,
  srcDir,
  srcFile,
}: {
  additionalModulePaths?: string[]
  basePath?: string
  config: FunctionConfig
  externalModules: string[]
  featureFlags: FeatureFlags
  ignoredModules: string[]
  name: string
  srcDir: string
  srcFile: string
}) {
  // We use a temporary directory as the destination for esbuild files to avoid
  // any naming conflicts with files generated by other functions.
  const targetDirectory = await tmpName()

  // De-duping external and ignored modules.
  const external = [...new Set([...externalModules, ...ignoredModules])]

  // To be populated by the native modules plugin with the names, versions and
  // paths of any Node modules with native dependencies.
  const nativeNodeModules = {}

  // To be populated by the dynamic imports plugin with the names of the Node
  // modules that include imports with dynamic expressions.
  const nodeModulesWithDynamicImports: Set<string> = new Set()

  // To be populated by the dynamic imports plugin with any paths (in a glob
  // format) to be included in the bundle in order to make a dynamic import
  // work at runtime.
  const dynamicImportsIncludedPaths: Set<string> = new Set()

  // The list of esbuild plugins to enable for this build.
  const plugins = [
    getNodeBuiltinPlugin(),
    getNativeModulesPlugin(nativeNodeModules),
    getDynamicImportsPlugin({
      basePath,
      includedPaths: dynamicImportsIncludedPaths,
      moduleNames: nodeModulesWithDynamicImports,
      processImports: config.processDynamicNodeImports !== false,
      srcDir,
    }),
  ]

  // The version of ECMAScript to use as the build target. This will determine
  // whether certain features are transpiled down or left untransformed.
  const nodeTarget = getBundlerTarget(config.nodeVersion)

  // esbuild will format `sources` relative to the sourcemap file, which lives
  // in `destFolder`. We use `sourceRoot` to establish that relation. They are
  // URLs, not paths, so even on Windows they should use forward slashes.
  const sourceRoot = targetDirectory.replace(/\\/g, '/')

  // Configuring the output format of esbuild. The `includedFiles` array we get
  // here contains additional paths to include with the bundle, like the path
  // to a `package.json` with {"type": "module"} in case of an ESM function.
  const { includedFiles: includedFilesFromModuleDetection, moduleFormat } = await getModuleFormat(
    srcDir,
    featureFlags,
    config.nodeVersion,
  )

  try {
    const { metafile = { inputs: {}, outputs: {} }, warnings } = await build({
      bundle: true,
      entryPoints: [srcFile],
      external,
      format: moduleFormat,
      logLevel: 'warning',
      logLimit: ESBUILD_LOG_LIMIT,
      metafile: true,
      nodePaths: additionalModulePaths,
      outdir: targetDirectory,
      platform: 'node',
      plugins,
      resolveExtensions: RESOLVE_EXTENSIONS,
      sourcemap: Boolean(config.nodeSourcemap),
      sourceRoot,
      target: [nodeTarget],
    })
    const bundlePaths = getBundlePaths({
      destFolder: targetDirectory,
      outputs: metafile.outputs,
      srcFile,
    })
    const inputs = Object.keys(metafile.inputs).map((path) => resolve(path))
    const cleanTempFiles = getCleanupFunction([...bundlePaths.keys()])
    const additionalPaths = [...dynamicImportsIncludedPaths, ...includedFilesFromModuleDetection]

    return {
      additionalPaths,
      bundlePaths,
      cleanTempFiles,
      inputs,
      moduleFormat,
      nativeNodeModules,
      nodeModulesWithDynamicImports: [...nodeModulesWithDynamicImports],
      warnings,
    }
  } catch (error) {
    throw FunctionBundlingUserError.addCustomErrorInfo(error, {
      functionName: name,
      runtime: RuntimeType.JAVASCRIPT,
      bundler: NodeBundlerType.ESBUILD,
    })
  }
}

// Takes the `outputs` object produced by esbuild and returns a Map with the
// absolute paths of the generated files as keys, and the paths that those
// files should take in the generated bundle as values. This is compatible
// with the `aliases` format used upstream.
const getBundlePaths = ({
  destFolder,
  outputs,
  srcFile,
}: {
  destFolder: string
  outputs: Metafile['outputs']
  srcFile: string
}) => {
  const bundleFilename = `${basename(srcFile, extname(srcFile))}.js`
  const mainFileDirectory = dirname(srcFile)
  const bundlePaths: Map<string, string> = new Map()

  // The paths returned by esbuild are relative to the current directory, which
  // is a problem on Windows if the target directory is in a different drive
  // letter. To get around that, instead of using `path.resolve`, we compute
  // the absolute path by joining `destFolder` with the `basename` of each
  // entry of the `outputs` object.
  Object.entries(outputs).forEach(([path, output]) => {
    const filename = basename(path)
    const extension = extname(path)
    const absolutePath = join(destFolder, filename)

    if (output.entryPoint && basename(output.entryPoint) === basename(srcFile)) {
      // Ensuring the main file has a `.js` extension.
      const normalizedSrcFile = getPathWithExtension(srcFile, '.js')

      bundlePaths.set(absolutePath, normalizedSrcFile)
    } else if (extension === '.js' || filename === `${bundleFilename}.map`) {
      bundlePaths.set(absolutePath, join(mainFileDirectory, filename))
    }
  })

  return bundlePaths
}

const getCleanupFunction = (paths: string[]) => async () => {
  await Promise.all(paths.filter(Boolean).map(safeUnlink))
}
