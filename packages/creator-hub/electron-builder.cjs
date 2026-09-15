const { execSync } = require('child_process');
const path = require('path');

// On PRs (dry-run) skip the slow .dmg build and ship only the unsigned .zip; electron-builder
// already skips code signing on PRs, so this keeps a downloadable per-PR build for a fraction
// of the time. Release builds (not dry-run) still produce the signed, notarized dmg + zip.
const isDryRun = process.env.DRY_RUN === 'true';

const config = {
  appId: 'com.decentraland.creatorshub',
  directories: {
    output: 'dist',
    buildResources: 'buildResources',
  },
  beforePack: path.join(__dirname, 'scripts', 'before-pack.js'),
  afterPack: path.join(__dirname, 'scripts', 'after-pack.js'),
  // The only native dep (node-pty) ships N-API prebuilds for every target (darwin/win ×
  // arm64/x64), which are ABI-stable under Electron — so don't let @electron/rebuild recompile
  // it from source. That rebuild failed the Windows CI build outright ("Could not find any
  // Visual Studio installation"): the runner has no C++ toolchain, and none is needed.
  npmRebuild: false,
  // npm must be under app dir for asarUnpack to match (26.4.1+). beforePack runs before file copy.
  files: [
    'package.json',
    'main/dist/**',
    'preload/dist/**',
    'renderer/dist/**',
    {
      from: 'node_modules/npm',
      to: 'node_modules/npm',
      filter: ['**/*'],
    },
    {
      from: 'node_modules/npm/node_modules',
      to: 'node_modules/npm/node_modules',
      filter: ['**/*'],
    },
  ],
  // node-pty ships N-API .node prebuilds + a spawn-helper binary that must run from disk,
  // not from inside the asar (#1531 drives the CLI login through a PTY).
  // The optimizer toolchain (sharp, gltf-transform, …) is NOT packaged: it is downloaded on
  // first use into userData (main/src/modules/optimizer/tools.ts).
  asarUnpack: ['node_modules/npm/**/*', 'node_modules/node-pty/**/*'],
  extraResources: [
    {
      from: 'devtools-frontend',
      to: 'devtools-frontend',
      filter: ['**/*'],
    },
    // Real Node.js binary, fetched by the beforePack hook. Scene tooling is spawned on this
    // instead of Electron so the multiplayer server gets a runtime whose ABI matches the
    // native builds it depends on. TEMPORARY: remove with the Bevy migration.
    {
      from: 'node-bin',
      to: 'node-bin',
      filter: ['**/*'],
    },
  ],
  linux: {
    target: 'deb',
  },
  productName: 'Decentraland Creator Hub',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  protocols: [
    {
      name: 'Decentraland Creator Hub',
      schemes: ['dcl-creator-hub'],
    },
  ],
  win: {
    appId: 'Decentraland.CreatorsHub',
    icon: 'buildResources/icon.ico',
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    extraResources: ['buildResources/icon.ico'],
    verifyUpdateCodeSignature: false,
    signtoolOptions: {
      publisherName: 'Decentraland Foundation',
    },
  },
  nsis: {
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'Decentraland Creator Hub',
    installerSidebar: 'buildResources/background.bmp',
    installerIcon: 'buildResources/icon.ico',
    include: 'buildResources/scripts/windowsInstaller.nsh',
  },
  dmg: {
    title: 'Decentraland Creator Hub Installer',
    background: 'buildResources/background.png',
    window: {
      width: 714,
      height: 472,
    },
    contents: [
      {
        x: 230,
        y: 215,
        type: 'file',
      },
      {
        x: 460,
        y: 215,
        type: 'link',
        path: '/Applications',
      },
    ],
    writeUpdateInfo: false,
  },
  mac: {
    target: isDryRun
      ? [
          { target: 'zip', arch: 'arm64' },
          { target: 'zip', arch: 'x64' },
        ]
      : [
          { target: 'dmg', arch: 'arm64' },
          { target: 'dmg', arch: 'x64' },
          { target: 'zip', arch: 'arm64' },
          { target: 'zip', arch: 'x64' },
        ],
  },
  publish: [
    {
      provider: 'github',
      vPrefixedTagName: false,
      owner: 'decentraland',
      repo: 'creator-hub',
    },
  ],
};

if (process.env.CODE_SIGN_SCRIPT_PATH) {
  console.log('CODE_SIGN_SCRIPT_PATH found in env vars:', process.env.CODE_SIGN_SCRIPT_PATH);
  config.win.signtoolOptions.sign = configuration => {
    console.log('Requested signing for ', configuration.path);

    // Only proceed if the versioned .exe file is in the configuration path - skip signing everything else
    if (!/Decentraland Creator Hub-(\d+)\.(\d+)\.(\d+)-win-x64.exe$/.test(configuration.path)) {
      console.log('This is not the versioned .exe, skip signing');
      return true;
    }

    const scriptPath = process.env.CODE_SIGN_SCRIPT_PATH;

    try {
      // Execute the sign script synchronously
      process.env.INPUT_COMMAND = 'sign';
      process.env.INPUT_FILE_PATH = configuration.path;
      const env = {
        command: process.env.INPUT_COMMAND,
        username: process.env.INPUT_USERNAME,
        password: process.env.INPUT_PASSWORD,
        credential_id: process.env.INPUT_CREDENTIAL_ID,
        totp_secret: process.env.INPUT_TOTP_SECRET,
        file_path: process.env.INPUT_FILE_PATH,
        output_path: process.env.INPUT_OUTPUT_PATH,
        malware_block: process.env.INPUT_MALWARE_BLOCK,
        override: process.env.INPUT_OVERRIDE,
        clean_logs: process.env.INPUT_CLEAN_LOGS,
        environment_name: process.env.INPUT_ENVIRONMENT_NAME,
        jvm_max_memory: process.env.INPUT_JVM_MAX_MEMORY,
      };
      console.log('env:', JSON.stringify(env, null, 2));
      // Use stdio 'inherit' so the esigner script output goes directly to the console.
      // execSync throws automatically on non-zero exit codes, which is sufficient to detect failures.
      execSync(`node "${scriptPath}"`, {
        env: { ...process.env, ...env },
        stdio: 'inherit',
      });
    } catch (error) {
      console.error(`Code signing failed: ${error.message}`);
      throw error;
    }

    return true; // Return true at the end of successful signing
  };

  // sign only for Windows 10 and above - adjust for your code as needed
  config.win.signtoolOptions.signingHashAlgorithms = ['sha256'];
}

module.exports = config;
//
