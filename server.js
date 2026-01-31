const mediasoup = require("mediasoup");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = 5000;

/* ---------------- GLOBAL ---------------- */

let worker;
let router;

const clients = new Map();
const producers = new Map();

/* ---------------- MEDIASOUP ---------------- */

async function createWorker() {
    worker = await mediasoup.createWorker({
        rtcMinPort: 40000,
        rtcMaxPort: 40100,
    });

    worker.on("died", () => {
        console.error("Worker died");
        process.exit(1);
    });

    router = await worker.createRouter({
        mediaCodecs: [
            {
                kind: "audio",
                mimeType: "audio/opus",
                clockRate: 48000,
                channels: 2,
            },
            {
                kind: "video",
                mimeType: "video/vp8",
                clockRate: 90000,
            },
        ],
    });
}

async function createTransport() {
    const transport = await router.createWebRtcTransport({
        listenIps: [
            {
                ip: "0.0.0.0",   // 🔥 IMPORTANT
                announcedIp: '13.233.157.192'
            }
        ],

        enableUdp: true,
        enableTcp: true,
        preferUdp: true,

        iceServers: [
            { urls: "stun:stun.l.google.com:19302" }
        ]
    });

    console.log("Transport created:", transport.id);

    return transport;
}

/* ---------------- WS ---------------- */

const wss = new WebSocket.Server({ port: PORT });

wss.on("connection", async (ws) => {

    const clientId = crypto.randomUUID();

    console.log("Client joined:", clientId);

    clients.set(clientId, {
        ws,
        sendTransport: null,
        recvTransport: null,
        producers: new Set(),
    });

    ws.on("message", async (msg) => {

        const data = JSON.parse(msg);
        const client = clients.get(clientId);

        switch (data.action) {

            /* ---- CAPS ---- */

            case "getRouterRtpCapabilities":

                ws.send(JSON.stringify({
                    action: "routerRtpCapabilities",
                    data: router.rtpCapabilities
                }));

                break;


            /* ---- CREATE SEND ---- */

            case "createSendTransport": {

                const transport = await createTransport();

                client.sendTransport = transport;

                ws.send(JSON.stringify({
                    action: "sendTransportCreated",
                    data: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    },
                }));

                break;
            }


            /* ---- CREATE RECV ---- */

            case "createRecvTransport": {

                const transport = await createTransport();

                client.recvTransport = transport;

                ws.send(JSON.stringify({
                    action: "recvTransportCreated",
                    data: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    },
                }));

                break;
            }


            /* ---- CONNECT ---- */

            case "connectTransport": {

                const transport =
                    client.sendTransport?.id === data.transportId
                        ? client.sendTransport
                        : client.recvTransport;

                if (!transport) return;

                await transport.connect({
                    dtlsParameters: data.dtlsParameters
                });

                console.log("Transport connected:", transport.id);

                ws.send(JSON.stringify({
                    action: "transportConnected",
                    transportId: transport.id
                }));

                break;
            }


            /* ---- PRODUCE ---- */

            case "produce": {

                const producer = await client.sendTransport.produce({
                    kind: data.kind,
                    rtpParameters: data.rtpParameters,
                    appData: { owner: clientId }
                });

                producers.set(producer.id, producer);
                client.producers.add(producer.id);

                console.log("Producer:", producer.id);

                ws.send(JSON.stringify({
                    action: "produced",
                    data: {
                        producerId: producer.id
                    }
                }));

                broadcastProducer(clientId, producer.id);

                break;
            }


            /* ---- CONSUME ---- */

            case "consume": {

                const producer = producers.get(data.producerId);

                if (!producer) return;

                if (producer.appData.owner === clientId) return;

                if (!router.canConsume({
                    producerId: producer.id,
                    rtpCapabilities: data.rtpCapabilities
                })) return;


                const consumer = await client.recvTransport.consume({
                    producerId: producer.id,
                    rtpCapabilities: data.rtpCapabilities,
                    paused: false,
                });

                ws.send(JSON.stringify({
                    action: "consumed",
                    data: {
                        id: consumer.id,
                        producerId: producer.id,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    },
                }));

                break;
            }


            /* ---- PRODUCERS ---- */

            case "getProducers": {

                const list = [];

                for (const [id, producer] of producers) {
                    if (producer.appData.owner !== clientId) {
                        list.push(id);
                    }
                }

                ws.send(JSON.stringify({
                    action: "existingProducers",
                    data: list
                }));

                break;
            }
        }
    });


    ws.on("close", () => {

        console.log("Client left:", clientId);

        const client = clients.get(clientId);

        for (const pid of client.producers) {
            broadcastLeft(clientId, pid);
            producers.get(pid)?.close();
            producers.delete(pid);
        }

        client.sendTransport?.close();
        client.recvTransport?.close();

        clients.delete(clientId);
    });
});

function broadcastLeft(clientId, producerId) {
    for (const [id, client] of clients) {

        if (id === clientId) continue;

        client.ws.send(JSON.stringify({
            action: "clientLeft",
            data: { producerId }
        }));
    }
}

function broadcastProducer(senderId, producerId) {

    for (const [id, client] of clients) {

        if (id === senderId) continue;

        client.ws.send(JSON.stringify({
            action: "newProducer",
            data: { producerId }
        }));
    }
}


/* ---------------- BOOT ---------------- */

(async () => {

    await createWorker();

    console.log("SFU running on ws://0.0.0.0:5000");

})();
