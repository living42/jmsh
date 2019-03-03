/**
 * # Stage 1
 *
 * - Login (2FA)
 * - Establish socketio connection
 * - Get Servers
 * - Connect Server
 * - Create a terminal
 *
 * ## Stage 2
 *
 * - Load config and session
 * - Login if no session of session is expired
 *   - save session
 * - Establish socketio connection
 * - Get Servers
 * - Connect Server
 * - Create a terminal
 *
 * ## Stage 3
 *
 * - Load config and session
 * - Try connect agent
 *   - Start a agent
 *   - Login
 *   - Establish socketio connection
 *   - Bind a unixsock wait for server connection request
 * - Ask agent to connect to server
 * - Create a terminal
 * - If this is last server connect then agent will exit
 */
import io from "socket.io-client";
import { CookieJar } from "tough-cookie";
import { URLSearchParams } from "url";
import UUID from "uuid-js";
import {client as http} from "./http";

class Term {
  protected url: string;
  protected csrftoken?: string;
  protected sessionId?: string;
  protected socket?: SocketIOClient.Socket;

  constructor(url: string) {
    this.url = url;
  }

  public async login() {
    const resp = await http.get(`${this.url}/users/login/`);

    const m = /<input type="hidden" name="csrfmiddlewaretoken" value="(\w+)">/.exec(resp.data);
    if (!m) {
      console.error("Cannot find csrfmiddlewaretoken.");
      process.exit(1);
      return;
    }

    const csrfToken = cookieGetValue(http.cookies, this.url, "csrftoken");

    this.csrftoken = csrfToken;

    const form = new URLSearchParams();
    form.append("csrfmiddlewaretoken", csrfToken);
    form.append("username", "admin");
    form.append("password", "admin");
    const loginResp = await http.post(`${this.url}/users/login/`, form, {maxRedirects: 0});
    if (loginResp.status !== 302) {
      console.error("Failed to login: please check you username and password");
      process.exit(1);
    }
    const sessionId = cookieGetValue(http.cookies, this.url, "sessionid");

    this.sessionId = sessionId;
  }

  public async establishConnection() {
    const socket = io.connect(`${this.url}/ssh`, {
      transportOptions: {
        polling: {
          extraHeaders: {
            cookie: `csrftoken=${this.getCsrfToken()}; sessionid=${this.getSessionId()}`,
          },
        },
      },
    });
    await new Promise((resolve) => {
      socket.on("connect", resolve);
    });
    this.socket = socket;
  }

  public async connect(name: string) {
    const asset = (await this.getAssets())
      .filter((node) => node.meta.type === "asset" && node.name === name)[0];

    const secret = UUID.create().toString();

    const socket = this.getSocket();

    socket.emit("host", {
      uuid: asset.id,
      userid: asset.meta.system_users[0].id,
      secret: secret,
      size: [process.stdout.columns, process.stdout.rows],
    });

    socket.on("data", (data: any) => {
      process.stdout.write(data.data);
    });

    const setRawMode = (mode: boolean) => {
      if (!process.stdin.setRawMode) {
        throw new Error("Please run this program in terminal");
      }
      process.stdin.setRawMode(mode);
    };

    let room: string;
    socket.on("room", (data: any) => {
      if (data.secret === secret) {
        room = data.room;
        socket.off("room");
        setRawMode(true);
      }
    });

    process.stdin.on("data", (chunk) => {
      socket.emit("data", {data: chunk.toString(), room: room});
    });

    socket.on("logout", (data: any) => {
      if (data.room === room) {
        setRawMode(false);
        process.exit(0);
      }
    });
  }

  protected async getAssets() {
    const resp2 = await http.get(`${this.url}/api/perms/v1/user/nodes-assets/tree/`);

    interface IAssetSystemUser {
      id: string;
    }
    interface ITreeNodeMeta {
      type: "node" | "asset";
      system_users: IAssetSystemUser[];
    }
    interface ITreeNode {
      id: string;
      meta: ITreeNodeMeta;
      name: string;
    }
    return resp2.data as ITreeNode[];
  }

  protected getCsrfToken(): string {
    if (!this.csrftoken) {
      throw new Error("csrftoken is undefined");
    }
    return this.csrftoken;
  }

  protected getSessionId(): string {
    if (!this.sessionId) {
      throw new Error("sessionId is undefined");
    }
    return this.sessionId;
  }

  protected getSocket(): SocketIOClient.Socket {
    if (!this.socket) {
      throw new Error("socket is undefined");
    }
    return this.socket;
  }
}

export async function run() {
  const nodeName = process.argv[2];
  if (!nodeName) {
    console.error("Please specify server name to connect");
    process.exit(1);
  }
  const term = new Term("http://localhost:8080");
  await term.login();
  await term.establishConnection();
  await term.connect(nodeName);
}

function cookieGetValue(jar: CookieJar, currentUrl: string, name: string): string {
  const cookie = jar.getCookiesSync(currentUrl).filter((c) => c.key === name)[0];
  if (cookie) {
    return cookie.value;
  } else {
    throw new Error(`${name} not found`);
  }
}
