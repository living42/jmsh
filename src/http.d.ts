import { AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";

interface HttpInstance extends AxiosInstance {
    cookies: CookieJar
}
export var client: HttpInstance
