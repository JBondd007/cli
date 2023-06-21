const t = require('tap')
const spawn = require('@npmcli/promise-spawn')
const { spawnSync } = require('child_process')
const { resolve, join, extname } = require('path')
const { readFileSync, chmodSync, readdirSync } = require('fs')
const Diff = require('diff')
const { version } = require('../../package.json')

const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin')
const SHIMS = readdirSync(BIN).reduce((acc, shim) => {
  if (extname(shim) !== '.js') {
    acc[shim] = readFileSync(join(BIN, shim), 'utf-8')
  }
  return acc
}, {})

t.test('npm vs npx', t => {
  // these scripts should be kept in sync so this tests the contents of each
  // and does a diff to ensure the only differences between them are necessary
  const diffFiles = (npm, npx) => Diff.diffChars(npm, npx)
    .filter(v => v.added || v.removed)
    .map((v, i) => i === 0 ? v.value : v.value.toUpperCase())

  t.test('bash', t => {
    const [npxCli, ...changes] = diffFiles(SHIMS.npm, SHIMS.npx)
    const npxCliLine = npxCli.split('\n').reverse().join('')
    t.match(npxCliLine, /^NPX_CLI_JS=/, 'has NPX_CLI')
    t.equal(changes.length, 20)
    t.strictSame([...new Set(changes)], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })

  t.test('cmd', t => {
    const [npxCli, ...changes] = diffFiles(SHIMS['npm.cmd'], SHIMS['npx.cmd'])
    t.match(npxCli, /^SET "NPX_CLI_JS=/, 'has NPX_CLI')
    t.equal(changes.length, 12)
    t.strictSame([...new Set(changes)], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })

  t.end()
})

t.test('basic', async t => {
  if (process.platform !== 'win32') {
    t.comment('test only relevant on windows')
    return
  }

  const path = t.testdir({
    ...SHIMS,
    'node.exe': readFileSync(process.execPath),
    // simulate the state where one version of npm is installed
    // with node, but we should load the globally installed one
    'global-prefix': {
      node_modules: {
        npm: t.fixture('symlink', ROOT),
      },
    },
    // put in a shim that ONLY prints the intended global prefix,
    // and should not be used for anything else.
    node_modules: {
      npm: {
        bin: {
          'npx-cli.js': `
            throw new Error('this should not be called')
          `,
          'npm-cli.js': `
            const assert = require('assert')
            const args = process.argv.slice(2)
            assert.equal(args[0], 'prefix')
            assert.equal(args[1], '-g')
            const { resolve } = require('path')
            console.log(resolve(__dirname, '../../../global-prefix'))
          `,
        },
      },
    },
  })

  for (const shim of Object.keys(SHIMS)) {
    chmodSync(join(path, shim), 0o755)
  }

  const matchSpawn = async (t, cmd, args = []) => {
    const isNpm = args.some(a => /npm/.test(a))
    const result = await spawn(cmd, [...args, isNpm ? 'help' : '--version'], {
      // don't hit the registry for the update check
      env: { PATH: path, npm_config_update_notifier: 'false' },
      cwd: path,
    })
    t.match(result, {
      code: 0,
      signal: null,
      stderr: '',
      stdout: isNpm ? `npm@${version} ${ROOT}` : version,
    })
  }

  await t.test('cmd', async t => {
    await matchSpawn(t, 'npm.cmd')
    await matchSpawn(t, 'npx.cmd')
  })

  await t.test('bash', async t => {
    const { ProgramFiles, SystemRoot, NYC_CONFIG } = process.env
    const gitBash = join(ProgramFiles, 'Git', 'bin', 'bash.exe')
    const gitUsrBinBash = join(ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe')
    const wslBash = join(SystemRoot, 'System32', 'bash.exe')
    const cygwinBash = join(SystemRoot, '/', 'cygwin64', 'bin', 'bash.exe')

    const bashes = Object.entries({
      'wsl bash': wslBash,
      'git bash': gitBash,
      'git internal bash': gitUsrBinBash,
      'cygwin bash': cygwinBash,
    }).map(([name, cmd]) => {
      let skip
      if (cmd === cygwinBash && NYC_CONFIG) {
        skip = 'does not play nicely with NYC, run without coverage'
      } else {
        try {
        // If WSL is installed, it *has* a bash.exe, but it fails if
        // there is no distro installed, so we need to detect that.
          if (spawnSync(cmd, ['-l', '-c', 'exit 0']).status !== 0) {
            throw new Error('not installed')
          }
        } catch {
          skip = 'not installed'
        }
      }
      return { name, cmd, skip }
    })

    for (const { name, cmd, skip } of bashes) {
      if (skip) {
        t.skip(name, { diagnostic: true, cmd, reason: skip })
        continue
      }

      await t.test(name, async t => {
        // only cygwin *requires* the -l, but the others are ok with it
        await matchSpawn(t, cmd, ['-l', 'npm'])
        await matchSpawn(t, cmd, ['-l', 'npx'])
      })
    }
  })
})
