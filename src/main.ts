#!/usr/bin/env node
import os from 'os'
import path from 'path'
import fs from 'fs'
import { login } from './auth'
import * as agent from './agent'
import * as endpoints from './endpoints'
import * as rpc from './rpc'
import inquirer from 'inquirer'
import child_process from 'child_process'
import pkg from '../package.json'
import { URL } from 'url';

const VERSION = pkg.version

interface Config {
  endpoint: string
  username: string
  configDir: string
}

export async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage:')
    console.log('  jmsh [hostname]')
    process.exit()
  }
  console.log(`jmsh ${VERSION}`)
  if (process.env.JMSH_AGENT_MODE === '1') {
    agent.startAgent()
    return
  }

  try {
    await client()
    process.exit(0)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}
main()

async function client() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const configDir = path.join(configHome, 'jmsh')
  const configPath = path.join(configDir, 'config.json')

  if (needSetup(configPath)) {
    await setup(configPath)
  }

  const config: Config = JSON.parse(fs.readFileSync(configPath).toString())

  const sockName = `.jmsh-${os.userInfo().uid}-${VERSION}`
  const sockPath = path.join(os.tmpdir(), `${sockName}.sock`)
  if (!fs.existsSync(sockPath)) {
    await spawnAgent(sockPath)
  }
  const client = new agent.Client(sockPath)

  if (!(await endpoints.checkConnection.call({ endpoint: config.endpoint, username: config.username }, client))) {
    await askLogin(client, config)
  }

  const hostname = process.argv[2]

  let asset: agent.Asset
  if (hostname) {
    let assets = await endpoints.getAssets.call(
      { endpoint: config.endpoint, username: config.username, fromCache: true },
      client
    )
    asset = assets.filter(asset => asset.hostname === hostname)[0]
    if (!asset) {
      assets = await endpoints.getAssets.call(
        { endpoint: config.endpoint, username: config.username, fromCache: false },
        client
      )
      asset = assets.filter(asset => asset.hostname === hostname)[0]
    }
  } else {
    const assets = await endpoints.getAssets.call(
      { endpoint: config.endpoint, username: config.username, fromCache: false },
      client
    )
    inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'))
    const questions = {
      type: 'autocomplete',
      name: 'asset',
      message: 'Select which asset you want to access',
      // choices: assets.map(asset => ({ name: `${asset.group}/${asset.hostname}`, value: asset })),
      async source(answerSoFar: any, input: string) {
        input = input || ''

        const regexp = new RegExp(input)

        return assets
          .map(asset => ({ name: `${asset.group}/${asset.hostname}`, value: asset }))
          .filter(choise => regexp.test(choise.name))
      }
    }
    const answer = await inquirer.prompt<{ asset: agent.Asset }>(questions)

    asset = answer.asset
  }

  if (!asset) {
    console.log('asset not found, make sure its exists and you have the permission to access it.')
    process.exit(1)
  }

  const user = asset['system_users_granted'][0]
  if (!user) {
    console.log('no system user granted to this asset for you, please make sure you have the permission to access it')
  }

  await connectAsset(client, config.endpoint, config.username, asset.id, user.id)
}

async function connectAsset(client: rpc.Client, endpoint: string, username: string, uuid: string, userid: string) {
  if (!process.stdin.setRawMode) {
    throw new Error('Please run this program in terminal')
  }

  const cols = process.stdout.columns || 24
  const rows = process.stdout.rows || 80
  const channel = await endpoints.connectAsset.call({ endpoint, username, uuid, userid, cols, rows }, client)

  // NOTE inquirer altered stdin we should resume it
  process.stdin.resume()

  process.stdin.setRawMode(true)
  try {
    await new Promise((resolve, reject) => {
      channel.on('end', resolve)
      channel.on('error', reject)
      channel.on('message', msg => {
        process.stdout.write(msg.data)
      })
      process.stdout.on('resize', () => {
        channel.send({
          event: 'resize',
          cols: process.stdout.columns || 24,
          rows: process.stdout.rows || 80
        })
      })
      process.stdin.on('data', data => {
        channel.send({ event: 'data', data: data.toString() })
      })
    })
  } finally {
    process.stdin.setRawMode(false)
  }
}

async function askLogin(client: rpc.Client, config: Config) {
  if (!config.username) {
    const { username } = await inquirer.prompt<{ username: string }>({
      name: 'username'
    })
    config.username = username
  }

  let savedPassword


  if (os.platform() === 'darwin') {
    savedPassword = await findPasswordInKeyChain(config)
  }

  const { password } = await inquirer.prompt<{ password: string }>({
    name: 'password',
    type: 'password',
    default: savedPassword,
    message: `password for [${config.username}]`
  })

  const credential = await login(config.endpoint, config.username, password)

  await endpoints.createConnection.call({ endpoint: config.endpoint, username: config.username, ...credential }, client)

  if (os.platform() === 'darwin' && password !== savedPassword) {
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>({
      "name": "confirm",
      "type": "confirm",
      "default": true,
      "message": "save your password into KeyChain?"
    })
    if (confirm) {
      await addPasswordToKeyChain(config, password)
      console.log("password saved into KeyChain")
    }
  }
}

async function findPasswordInKeyChain(config: Config): Promise<string | null> {
  const host = new URL(config.endpoint).host
  const r = child_process.spawnSync("security", ["find-generic-password", "-a", `${config.username}@${host}`, "-c", "jmsh", "-s", 'jmsh account', "-gw"])
  if (r.status.toString() === '0') {
    return r.stdout.toString().trim()
  }
  if (r.status.toString() === '44') {
    return null
  }
  throw new Error(r.stderr.toString())
}

async function addPasswordToKeyChain(config: Config, password: string) {
  const host = new URL(config.endpoint).host
  const r = child_process.spawnSync("security", ["add-generic-password", "-a", `${config.username}@${host}`, "-c", "jmsh", "-C", "jmsh", "-D", 'Jumpserver account for jmsh', "-s", 'jmsh account', "-w", password, "-U"])
  if (r.status.toString() === '0') {
    return
  }
  throw new Error(r.stderr.toString())
}

function needSetup(configPath: string) {
  return !fs.existsSync(configPath) || process.argv.includes('--force-setup')
}

async function setup(configPath: string) {
  console.log("Let's setup your endpoint.")

  const questions: any[] = [
    {
      name: 'endpoint',
      default: 'http://localhost:8080'
    },
    {
      name: 'username'
    },
  ]

  const config = await inquirer.prompt<{ endpoint: string; username: string }>(questions)
  console.log(`Save your config to ${configPath}`)
  if (!fs.existsSync(path.dirname(configPath))) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
  }
  fs.writeFileSync(configPath, JSON.stringify(config, undefined, ' ') + '\n')
}

async function spawnAgent(sockPath: string) {
  const cp = child_process.spawn(process.argv[0], [process.argv[1]], {
    detached: true,
    stdio: 'ignore',
    env: {
      JMSH_AGENT_MODE: '1',
      JMSH_AGENT_SOCK_PATH: sockPath
    }
  })
  console.log('spawn agentd')
  console.log('pid:', cp.pid)
  await new Promise(async (resolve, reject) => {
    cp.on('error', reject)
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(sockPath)) {
        console.log('agent started')
        resolve()
        return
      }
      await delay(500)
    }
    if (!fs.existsSync(sockPath)) {
      reject('agent no start.')
    }
  })
  cp.unref()
}
