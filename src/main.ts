import inquirer from 'inquirer'
import Term, { ITreeNode } from './term'

export async function main() {
    console.log('jmsh 1.0')
    const nodeName = process.argv[2]

    const { serverUrl } = await inquirer.prompt<{ serverUrl: string }>({
        name: 'serverUrl',
        message: 'set your jumpserver:',
        default: 'http://localhost:8080'
    })

    const term = new Term(serverUrl)
    await term.login()
    await term.establishConnection()

    const assets = (await term.getAssets()).filter(node => node.meta.type === 'asset')

    let asset
    if (!nodeName) {
        const answer = await inquirer.prompt<{ asset: ITreeNode }>({
            type: 'list',
            name: 'asset',
            message: 'choose asset to connect:',
            choices: assets.map(x => ({ name: x.name, value: x }))
        })
        asset = answer.asset
    } else {
        asset = assets.filter(node => node.name === nodeName)[0]
    }

    if (!asset) {
        console.error('asset you specified no found')
        process.exit(1)
    }

    await term.connect(asset)
}
