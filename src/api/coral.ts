import fetch, { Response } from 'node-fetch';
import { v4 as uuidgen } from 'uuid';
import createDebug from 'debug';
import { f, FResult, HashMethod } from './f.js';
import { AccountLogin, AccountToken, Announcements, CurrentUser, CurrentUserPermissions, Event, Friends, GetActiveEventResult, PresencePermissions, User, WebServices, WebServiceToken, CoralErrorResponse, CoralResponse, CoralStatus, CoralSuccessResponse, FriendCodeUser, FriendCodeUrl, AccountTokenParameter, AccountLoginParameter, WebServiceTokenParameter } from './coral-types.js';
import { getNintendoAccountToken, getNintendoAccountUser, NintendoAccountToken, NintendoAccountUser } from './na.js';
import { ErrorResponse, ResponseSymbol } from './util.js';
import { JwtPayload } from '../util/jwt.js';
import { getAdditionalUserAgents } from '../util/useragent.js';
import { timeoutSignal } from '../util/misc.js';

const debug = createDebug('nxapi:api:coral');

const ZNCA_PLATFORM = 'Android';
const ZNCA_PLATFORM_VERSION = '8.0.0';
const ZNCA_VERSION = '2.2.0';
const ZNCA_USER_AGENT = `com.nintendo.znca/${ZNCA_VERSION}(${ZNCA_PLATFORM}/${ZNCA_PLATFORM_VERSION})`;

const ZNC_URL = 'https://api-lp1.znc.srv.nintendo.net';
export const ZNCA_CLIENT_ID = '71b963c1b7b6d119';

const FRIEND_CODE = /^\d{4}-\d{4}-\d{4}$/;
const FRIEND_CODE_HASH = /^[A-Za-z0-9]{10}$/;

export const ResponseDataSymbol = Symbol('ResponseData');
export const CorrelationIdSymbol = Symbol('CorrelationId');

export type Result<T> = T & ResultData<T>;

export interface ResultData<T> {
    [ResponseSymbol]: Response;
    [ResponseDataSymbol]: CoralSuccessResponse<T>;
    [CorrelationIdSymbol]: string;

    /** @deprecated */
    status: CoralStatus.OK;
    /** @deprecated */
    result: T;
    /** @deprecated */
    correlationId: string;
}

export default class CoralApi {
    onTokenExpired: ((data: CoralErrorResponse, res: Response) => Promise<CoralAuthData | void>) | null = null;
    /** @internal */
    _renewToken: Promise<void> | null = null;

    protected constructor(
        public token: string,
        public useragent: string | null = getAdditionalUserAgents(),
        readonly znca_version = ZNCA_VERSION,
        readonly znca_useragent = ZNCA_USER_AGENT,
    ) {}

    async fetch<T = unknown>(
        url: string, method = 'GET', body?: string, headers?: object,
        /** @internal */ _autoRenewToken = true,
        /** @internal */ _attempt = 0
    ): Promise<Result<T>> {
        if (this._renewToken && _autoRenewToken) {
            await this._renewToken;
        }

        const [signal, cancel] = timeoutSignal();
        const response = await fetch(ZNC_URL + url, {
            method,
            headers: Object.assign({
                'X-Platform': ZNCA_PLATFORM,
                'X-ProductVersion': this.znca_version,
                'Authorization': 'Bearer ' + this.token,
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': this.znca_useragent,
            }, headers),
            body,
            signal,
        }).finally(cancel);

        debug('fetch %s %s, response %s', method, url, response.status);

        if (response.status !== 200) {
            throw new ErrorResponse('[znc] Non-200 status code', response, await response.text());
        }

        const data = await response.json() as CoralResponse<T>;

        if (data.status === CoralStatus.TOKEN_EXPIRED && _autoRenewToken && !_attempt && this.onTokenExpired) {
            // _renewToken will be awaited when calling fetch
            this._renewToken = this._renewToken ?? this.onTokenExpired.call(null, data, response).then(data => {
                if (data) this.setTokenWithSavedToken(data);
            }).finally(() => {
                this._renewToken = null;
            });
            return this.fetch(url, method, body, headers, _autoRenewToken, _attempt + 1);
        }

        if ('errorMessage' in data) {
            throw new ErrorResponse('[znc] ' + data.errorMessage, response, data);
        }
        if (data.status !== CoralStatus.OK) {
            throw new ErrorResponse('[znc] Unknown error', response, data);
        }

        const result = data.result;

        Object.defineProperty(result, ResponseSymbol, {enumerable: false, value: response});
        Object.defineProperty(result, ResponseDataSymbol, {enumerable: false, value: data});
        Object.defineProperty(result, CorrelationIdSymbol, {enumerable: false, value: data.correlationId});

        Object.defineProperty(result, 'status', {enumerable: false, value: CoralStatus.OK});
        Object.defineProperty(result, 'result', {enumerable: false, value: data.result});
        Object.defineProperty(result, 'correlationId', {enumerable: false, value: data.correlationId});

        return result as Result<T>;
    }

    async call<T = unknown>(
        url: string, parameter = {},
        /** @internal */ _autoRenewToken = true
    ) {
        const uuid = uuidgen();

        return this.fetch<T>(url, 'POST', JSON.stringify({
            parameter,
            requestId: uuid,
        }), {}, _autoRenewToken);
    }

    async getAnnouncements() {
        return this.call<Announcements>('/v1/Announcement/List');
    }

    async getFriendList() {
        return this.call<Friends>('/v3/Friend/List');
    }

    async addFavouriteFriend(nsaid: string) {
        return this.call<{}>('/v3/Friend/Favorite/Create', {
            nsaId: nsaid,
        });
    }

    async removeFavouriteFriend(nsaid: string) {
        return this.call<{}>('/v3/Friend/Favorite/Delete', {
            nsaId: nsaid,
        });
    }

    async getWebServices() {
        return this.call<WebServices>('/v1/Game/ListWebServices');
    }

    async getActiveEvent() {
        return this.call<GetActiveEventResult>('/v1/Event/GetActiveEvent');
    }

    async getEvent(id: number) {
        return this.call<Event>('/v1/Event/Show', {
            id,
        });
    }

    async getUser(id: number) {
        return this.call<User>('/v3/User/Show', {
            id,
        });
    }

    async getUserByFriendCode(friend_code: string, hash?: string) {
        if (!FRIEND_CODE.test(friend_code)) throw new Error('Invalid friend code');
        if (hash && !FRIEND_CODE_HASH.test(hash)) throw new Error('Invalid friend code hash');

        return hash ? this.call<FriendCodeUser>('/v3/Friend/GetUserByFriendCodeHash', {
            friendCode: friend_code,
            friendCodeHash: hash,
        }) : this.call<FriendCodeUser>('/v3/Friend/GetUserByFriendCode', {
            friendCode: friend_code,
        });
    }

    async sendFriendRequest(nsa_id: string) {
        return this.call<{}>('/v3/FriendRequest/Create', {
            nsaId: nsa_id,
        });
    }

    async getCurrentUser() {
        return this.call<CurrentUser>('/v3/User/ShowSelf');
    }

    async getFriendCodeUrl() {
        return this.call<FriendCodeUrl>('/v3/Friend/CreateFriendCodeUrl');
    }

    async getCurrentUserPermissions() {
        return this.call<CurrentUserPermissions>('/v3/User/Permissions/ShowSelf');
    }

    async updateCurrentUserPermissions(to: PresencePermissions, from: PresencePermissions, etag: string) {
        return this.call<{}>('/v3/User/Permissions/UpdateSelf', {
            permissions: {
                presence: {
                    toValue: to,
                    fromValue: from,
                },
            },
            etag,
        });
    }

    async getWebServiceToken(id: number, /** @internal */ _attempt = 0): Promise<Result<WebServiceToken>> {
        await this._renewToken;

        const data = await f(this.token, HashMethod.WEB_SERVICE, {
            platform: ZNCA_PLATFORM,
            version: this.znca_version,
            useragent: this.useragent ?? getAdditionalUserAgents(),
        });

        const req: WebServiceTokenParameter = {
            id,
            registrationToken: '',
            f: data.f,
            requestId: data.request_id,
            timestamp: data.timestamp,
        };

        try {
            return await this.call<WebServiceToken>('/v2/Game/GetWebServiceToken', req, false);
        } catch (err) {
            if (err instanceof ErrorResponse && err.data.status === CoralStatus.TOKEN_EXPIRED && !_attempt && this.onTokenExpired) {
                debug('Error getting web service token, renewing token before retrying', err);
                // _renewToken will be awaited when calling getWebServiceToken
                this._renewToken = this._renewToken ?? this.onTokenExpired.call(null, err.data, err.response as Response).then(data => {
                    if (data) this.setTokenWithSavedToken(data);
                }).finally(() => {
                    this._renewToken = null;
                });
                return this.getWebServiceToken(id, _attempt + 1);
            } else {
                throw err;
            }
        }
    }

    async getToken(token: string, user: NintendoAccountUser): Promise<PartialCoralAuthData> {
        // Nintendo Account token
        const nintendoAccountToken = await getNintendoAccountToken(token, ZNCA_CLIENT_ID);

        const fdata = await f(nintendoAccountToken.id_token, HashMethod.CORAL, {
            platform: ZNCA_PLATFORM,
            version: this.znca_version,
            useragent: this.useragent ?? getAdditionalUserAgents(),
        });

        const req: AccountTokenParameter = {
            naBirthday: user.birthday,
            timestamp: fdata.timestamp,
            f: fdata.f,
            requestId: fdata.request_id,
            naIdToken: nintendoAccountToken.id_token,
        };

        const data = await this.call<AccountToken>('/v3/Account/GetToken', req, false);

        return {
            nintendoAccountToken,
            // user,
            f: fdata,
            nsoAccount: data,
            credential: data.webApiServerCredential,
        };
    }

    async renewToken(token: string, user: NintendoAccountUser) {
        const data = await this.getToken(token, user);
        this.setTokenWithSavedToken(data);
        return data;
    }

    /** @private */
    setTokenWithSavedToken(data: CoralAuthData | PartialCoralAuthData) {
        this.token = data.credential.accessToken;
    }

    static async createWithSessionToken(token: string, useragent = getAdditionalUserAgents()) {
        const data = await this.loginWithSessionToken(token, useragent);
        return {nso: this.createWithSavedToken(data, useragent), data};
    }

    static createWithSavedToken(data: CoralAuthData, useragent = getAdditionalUserAgents()) {
        return new this(
            data.credential.accessToken,
            useragent,
            data.znca_version,
            data.znca_useragent,
        );
    }

    static async loginWithSessionToken(token: string, useragent = getAdditionalUserAgents()): Promise<CoralAuthData> {
        const { default: { coral: config } } = await import('../common/remote-config.js');

        if (!config) throw new Error('Remote configuration prevents Coral authentication');
        const znca_useragent = `com.nintendo.znca/${config.znca_version}(${ZNCA_PLATFORM}/${ZNCA_PLATFORM_VERSION})`;

        // Nintendo Account token
        const nintendoAccountToken = await getNintendoAccountToken(token, ZNCA_CLIENT_ID);

        // Nintendo Account user data
        const user = await getNintendoAccountUser(nintendoAccountToken);

        const fdata = await f(nintendoAccountToken.id_token, HashMethod.CORAL, {
            platform: ZNCA_PLATFORM,
            version: config.znca_version,
            useragent,
        });

        debug('Getting Nintendo Switch Online app token');

        const parameter: AccountLoginParameter = {
            naIdToken: nintendoAccountToken.id_token,
            naBirthday: user.birthday,
            naCountry: user.country,
            language: user.language,
            timestamp: fdata.timestamp,
            requestId: fdata.request_id,
            f: fdata.f,
        };

        const [signal, cancel] = timeoutSignal();
        const response = await fetch(ZNC_URL + '/v3/Account/Login', {
            method: 'POST',
            headers: {
                'X-Platform': ZNCA_PLATFORM,
                'X-ProductVersion': config.znca_version,
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': znca_useragent,
            },
            body: JSON.stringify({
                parameter,
            }),
            signal,
        }).finally(cancel);

        debug('fetch %s %s, response %s', 'POST', '/v3/Account/Login', response.status);

        if (response.status !== 200) {
            throw new ErrorResponse('[znc] Non-200 status code', response, await response.text());
        }

        const data = await response.json() as CoralResponse<AccountLogin>;

        if ('errorMessage' in data) {
            throw new ErrorResponse('[znc] ' + data.errorMessage, response, data);
        }
        if (data.status !== CoralStatus.OK) {
            throw new ErrorResponse('[znc] Unknown error', response, data);
        }

        debug('Got Nintendo Switch Online app token', data);

        return {
            nintendoAccountToken,
            user,
            f: fdata,
            nsoAccount: data.result,
            credential: data.result.webApiServerCredential,
            znca_version: config.znca_version,
            znca_useragent,
        };
    }
}

export interface CoralAuthData {
    nintendoAccountToken: NintendoAccountToken;
    user: NintendoAccountUser;
    f: FResult;
    nsoAccount: AccountLogin;
    credential: AccountLogin['webApiServerCredential'];
    znca_version: string;
    znca_useragent: string;
}

export type PartialCoralAuthData =
    Pick<CoralAuthData, 'nintendoAccountToken' | 'f' | 'nsoAccount' | 'credential'>;

export interface CoralJwtPayload extends JwtPayload {
    isChildRestricted: boolean;
    membership: {
        active: boolean;
    };
    aud: string;
    exp: number;
    iat: number;
    iss: 'api-lp1.znc.srv.nintendo.net';
    /** Coral user ID (CurrentUser.id, not CurrentUser.nsaId) */
    sub: number;
    typ: 'id_token';
}
export interface CoralWebServiceJwtPayload extends JwtPayload {
    isChildRestricted: boolean;
    aud: string;
    exp: number;
    iat: number;
    iss: 'api-lp1.znc.srv.nintendo.net';
    jti: string;
    /** Coral user ID (CurrentUser.id, not CurrentUser.nsaId) */
    sub: number;
    links: {
        networkServiceAccount: {
            /** NSA ID (CurrentUser.nsaId) */
            id: string;
        };
    };
    typ: 'id_token';
    membership: {
        active: boolean;
    };
}
