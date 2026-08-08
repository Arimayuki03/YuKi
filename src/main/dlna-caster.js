/**
 * dlna-caster.js — DLNA 投屏（UPnP 设备发现 + 媒体投屏）
 *
 * 职责：
 * 1. SSDP M-SEARCH 发现局域网内 DLNA 设备（电视、机顶盒等）
 * 2. 向设备发送 SetAVTransportURI 投屏播放
 * 3. 发送 Stop 停止投屏
 *
 * 依赖：Node.js 内置 net/dgram/http，无第三方依赖。
 */
const dgram = require('dgram');
const http = require('http');
const { EventEmitter } = require('events');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_SEARCH = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 3',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    '',
    '',
].join('\r\n');

class DlnaCaster extends EventEmitter {
    constructor() {
        super();
        this.devices = new Map(); // location -> { name, controlUrl }
        this._onError = () => {};
    }

    /** 搜索局域网内 DLNA 设备（3s 超时）。 */
    search() {
        return new Promise((resolve) => {
            this.devices.clear();
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            const timer = setTimeout(() => {
                try { sock.close(); } catch (e) { /* ignore */ }
                const list = Array.from(this.devices.values());
                this.emit('devices', list);
                resolve(list);
            }, 3000);

            sock.on('message', (msg) => {
                const text = msg.toString('utf8');
                const locMatch = text.match(/LOCATION:\s*(.+)/i);
                if (!locMatch) return;
                const location = locMatch[1].trim();
                if (this.devices.has(location)) return;
                // 获取设备描述 XML，解析 friendlyName 与 controlUrl
                this._fetchDeviceDesc(location).then((dev) => {
                    if (dev) {
                        this.devices.set(location, dev);
                        this.emit('devices', Array.from(this.devices.values()));
                    }
                }).catch(() => { /* 单设备失败不影响其他 */ });
            });

            sock.bind(() => {
                sock.setBroadcast(true);
                sock.send(SSDP_SEARCH, 0, SSDP_SEARCH.length, SSDP_PORT, SSDP_ADDR);
            });

            sock.on('error', () => {
                clearTimeout(timer);
                try { sock.close(); } catch (e) { /* ignore */ }
                resolve([]);
            });
        });
    }

    /** 拉取设备描述 XML，解析 friendlyName 与 AVTransport control URL。 */
    async _fetchDeviceDesc(location) {
        return new Promise((resolve, reject) => {
            const req = http.get(location, { timeout: 5000 }, (rsp) => {
                let data = '';
                rsp.on('data', (chunk) => { data += chunk; });
                rsp.on('end', () => {
                    try {
                        const nameMatch = data.match(/<friendlyName>([^<]+)<\/friendlyName>/i);
                        const name = nameMatch ? nameMatch[1] : '未知设备';
                        // 解析 AVTransport service controlURL（相对路径需 urljoin）
                        const svcMatch = data.match(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:AVTransport:1<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>[\s\S]*?<\/service>/i);
                        if (!svcMatch) { resolve(null); return; }
                        const controlPath = svcMatch[1].trim();
                        const url = new URL(location);
                        const controlUrl = new URL(controlPath, `${url.protocol}//${url.host}`).href;
                        resolve({ name, location, controlUrl });
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    /** 投屏：向设备发送 SetAVTransportURI + Play。 */
    cast(deviceControlUrl, mediaUrl, title) {
        return new Promise((resolve, reject) => {
            const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${mediaUrl}</CurrentURI>
      <CurrentURIMetaData></CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;
            this._sendSoap(deviceControlUrl, 'SetAVTransportURI', soap).then(() => {
                // 设置成功后发送 Play
                const playSoap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;
                return this._sendSoap(deviceControlUrl, 'Play', playSoap);
            }).then(() => resolve()).catch(reject);
        });
    }

    /** 停止投屏。 */
    stop(deviceControlUrl) {
        const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>`;
        return this._sendSoap(deviceControlUrl, 'Stop', soap);
    }

    _sendSoap(controlUrl, action, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(controlUrl);
            const options = {
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = http.request(options, (rsp) => {
                if (rsp.statusCode >= 200 && rsp.statusCode < 300) resolve();
                else reject(new Error(`DLNA ${action} failed: ${rsp.statusCode}`));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}

module.exports = DlnaCaster;
