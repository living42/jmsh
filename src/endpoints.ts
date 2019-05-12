import * as rpc from './rpc'
import { Asset } from './agent'

interface checkConnectionReq {
  endpoint: string
  username: string
}

export const checkConnection = new rpc.CallEndpoint<checkConnectionReq, boolean>({
  name: 'checkConnection'
})

interface createConnectionReq {
  endpoint: string
  username: string
  sessionId: string
  csrfToken: string
}

export const createConnection = new rpc.CallEndpoint<createConnectionReq, void>({
  name: 'createConnection'
})

interface connectAssetReq {
  endpoint: string
  username: string
  uuid: string
  userid: string
  rows: number
  cols: number
}

interface Resize {
  event: 'resize'
  rows: number
  cols: number
}
interface Input {
  event: 'data'
  data: string
}

export type InputMsg = Resize | Input

export interface OutputMsg {
  data: string
}

export const connectAsset = new rpc.ChannelEndpoint<connectAssetReq, InputMsg, OutputMsg>({ name: 'connectAsset' })

interface getAssetsReq {
  endpoint: string
  username: string
  fromCache: boolean
}

type getAssetsRep = Asset[]

export const getAssets = new rpc.CallEndpoint<getAssetsReq, getAssetsRep>({ name: 'getAssets' })
