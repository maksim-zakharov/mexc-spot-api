import {PushDataV3ApiWrapper} from "./generated/PushDataV3ApiWrapper";
import {WebSocket} from 'ws';
import {PublicSpotKlineV3Api} from "./generated/PublicSpotKlineV3Api";
import {PublicLimitDepthsV3Api} from "./generated/PublicLimitDepthsV3Api";
import {PublicDealsV3Api} from "./generated/PublicDealsV3Api";
import {PublicAggreDealsV3Api} from "./generated/PublicAggreDealsV3Api";
import {PublicAggreDepthsV3Api} from "./generated/PublicAggreDepthsV3Api";
import {PublicBookTickerV3Api} from "./generated/PublicBookTickerV3Api";
import {PublicBookTickerBatchV3Api} from "./generated/PublicBookTickerBatchV3Api";
import {PrivateAccountV3Api} from "./generated/PrivateAccountV3Api";
import {PrivateDealsV3Api} from "./generated/PrivateDealsV3Api";
import {PrivateOrdersV3Api} from "./generated/PrivateOrdersV3Api";

const channelMapKey: Record<string, keyof PushDataV3ApiWrapper> = {
    'spot@public.kline.v3.api.pb': "publicSpotKline",
    'spot@public.limit.depth.v3.api.pb': 'publicLimitDepths',
    'spot@public.aggre.deals.v3.api.pb': 'publicAggreDeals',
    'spot@public.aggre.depth.v3.api.pb': 'publicAggreDepths',
    'spot@public.aggre.bookTicker.v3.api.pb': 'publicBookTicker',
    'spot@public.bookTicker.batch.v3.api.pb': 'publicBookTickerBatch',
    'spot@private.account.v3.api.pb': 'privateAccount',
    'spot@private.deals.v3.api.pb': 'privateDeals',
    'spot@private.orders.v3.api.pb': 'privateOrders'
}

export interface FinamApiOptions {
    /** Токен доступа */
    secret: string;
    /** API endpoint */
    endpoint?: string;
}

const defaults: Required<Pick<FinamApiOptions, 'endpoint'>> = {
    endpoint: 'wss://wbs-api.mexc.com/ws',
};

class WSClient{

    private pingInterval?: NodeJS.Timeout;
    // @ts-ignore
    private ws: WebSocket;

    private subscriptions = new Map<string, any>();

    private isConnected: boolean = false;

    private reconnectAttempts = 0;

    private maxReconnectAttempts = 5;
    private reconnectInterval = 1000;
    private reconnectDecay = 500;
    private maxReconnectInterval = 5000;

    options: FinamApiOptions & typeof defaults;

    constructor(options: FinamApiOptions) {
        this.options = Object.assign({}, defaults, options);
    }

    get size(){
        return this.subscriptions.size;
    }

    get(channel: string){
        return this.subscriptions.get(channel);
    }

    // Подключение к WebSocket
    private connect() {
        this.ws = new WebSocket(this.options.endpoint);

        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            console.log('WebSocket connected');

            // Повторная подписка на все события
            this.resubscribe();

            // Сохраняем ID интервала для последующей очистки
            this.pingPong();
        };

        this.ws.on('error', (err) => {
            console.error('WebSocket error:', err.message);
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
            }
        });

        this.ws.on('close', (code, reason) => {
            console.warn(`Connection closed: code=${code}, reason=${reason}`);
            this.isConnected = false;
            this.attemptReconnect();
        });

        this.ws.onmessage = ({data}) => {
            const isProbablyJson = () => {
                try {
                    const str = data.toString();
                    return str.startsWith('{') || str.startsWith('[');
                } catch (err) {
                    return false;
                }
            };

            if (isProbablyJson()) {
                try {
                    // const json = JSON.parse(data.toString());
                    // console.log('Received JSON:', JSON.stringify(json, null, 2));
                    return;
                } catch (err) {
                    console.error('Failed to parse JSON:', err.message);
                }
            }

            const message = PushDataV3ApiWrapper.decode(new Uint8Array(data as ArrayBuffer));
            const obj: any = PushDataV3ApiWrapper.toJSON(message);

            const key = `spot@` + obj.channel.split('@')[1];
            this.subscriptions.get(obj.channel)?.(obj[channelMapKey[key]])
        };
    }

    pingPong = () => {
        this.pingInterval = setInterval(() => {
            try {
                this.ws.send(JSON.stringify({method: "PING"}));
            } catch (error) {
                console.error('Error sending PING:', error);
            }
        }, 15000);
    };

    // Попытка переподключения
    private attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnect attempts reached');
            return;
        }

        const delay = Math.min(
            this.reconnectInterval *
            Math.pow(this.reconnectDecay, this.reconnectAttempts),
            this.maxReconnectInterval,
        );

        console.log(`Attempting to reconnect in ${delay}ms...`);
        setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
        }, delay);
    }

    // Повторная подписка на все события
    private resubscribe() {
        Array.from(this.subscriptions).forEach(([subscription, callback]) => {
            this.subscribe(subscription, callback);
            console.log(`Resubscribed to ${JSON.stringify(subscription)}`);
        });
    }

    public subscribe(channel: string, callback: any) {
        this.subscriptions.set(channel, callback)

        if (this.isConnected) {
            this.ws.send(JSON.stringify({
                method: 'SUBSCRIPTION',
                params: [
                    channel
                ]
            }));
        }
    }
}

export class MexcSpotApi {
    options: FinamApiOptions & typeof defaults;

    private clients: WSClient[] = [];

    constructor(options: FinamApiOptions) {
        this.options = Object.assign({}, defaults, options);
    }

    findClientByChannel(channel: string){
        return this.clients.find(c => c.get(channel));
    }

    get clientsCount(){
        return this.clients.length;
    }

    get totalSize(){
        return this.clients.reduce((acc, curr) => acc + curr.size, 0);
    }

    get lastClient() {
        let client = this.clients[0];
        // Максимум по 30 соединений, подстрахуемся на 25
        if(!client || client.size >= 25){
            client = new WSClient(this.options);
            this.clients.unshift(client)
        }

        return client;
    }

    subscribe(channel: string, callback: any){
        // Либо суем туда где уже зарегано, либо создаем новый клиент
        const client = this.findClientByChannel(channel);
        if(client) client.subscribe(channel, callback)
        else this.lastClient.subscribe(channel, callback)
    }

     subscribeAccountOrders(callback: (response: PrivateOrdersV3Api) => void) {
        const channel = `spot@private.orders.v3.api.pb`;

        this.subscribe(channel, callback)
    }

     subscribeAccountDeals(callback: (response: PrivateDealsV3Api) => void) {
        const channel = `spot@private.deals.v3.api.pb`;

        this.subscribe(channel, callback)
    }

     subscribeAccount(callback: (response: PrivateAccountV3Api) => void) {
        const channel = `spot@private.account.v3.api.pb`;

        this.subscribe(channel, callback)
    }

     subscribeLimitDepths(params: {
        symbol: string;
        level: 5 | 10 | 20;
    }, callback: (response: PublicLimitDepthsV3Api) => void) {
        const channel = `spot@public.limit.depth.v3.api.pb@${params.symbol}@${params.level}`;

        this.subscribe(channel, callback)
    }

     subscribeBookTickerBatch(params: {
        symbol: string;
    }, callback: (response: PublicBookTickerBatchV3Api) => void) {
        const channel =  `spot@public.bookTicker.batch.v3.api.pb@${params.symbol}`;

        this.subscribe(channel, callback)
    }

     subscribeBookTicker(params: {
        symbol: string;
        delay: '10ms' | '100ms';
    }, callback: (response: PublicBookTickerV3Api) => void) {
        const channel =  `spot@public.aggre.bookTicker.v3.api.pb@${params.delay}@${params.symbol}`;

        this.subscribe(channel, callback)
    }

     subscribeAggreDepths(params: {
        symbol: string;
        delay: '10ms' | '100ms';
    }, callback: (response: PublicAggreDepthsV3Api) => void) {
        const channel =  `spot@public.aggre.depth.v3.api.pb@${params.delay}@${params.symbol}`;

        this.subscribe(channel, callback)
    }

     subscribeAggreDeals(params: {
        symbol: string;
        delay: '10ms' | '100ms';
    }, callback: (response: PublicAggreDealsV3Api) => void) {
        const channel =  `spot@public.aggre.deals.v3.api.pb@${params.delay}@${params.symbol}`;

        this.subscribe(channel, callback)
    }

     subscribeSpotKline(params: {
        symbol: string;
        interval: string;
    }, callback: (response: PublicSpotKlineV3Api) => void) {
        const channel = `spot@public.kline.v3.api.pb@${params.symbol}@${params.interval}`;

        this.subscribe(channel, callback)
    }
}
