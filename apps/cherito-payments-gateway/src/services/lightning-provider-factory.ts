import {
  LndRestProvider,
  loadCredential,
  type LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import type { Config } from '../config.js'

/** Central production provider selection point. Only LND is production-ready today. */
export async function createLightningProvider(config: Config): Promise<LightningReceiveProvider> {
  switch (config.LIGHTNING_PROVIDER) {
    case 'lnd': {
      const [certificate, macaroon] = await Promise.all([
        loadCredential(config.LND_TLS_CERT_PATH, config.LND_TLS_CERT_BASE64, 'base64'),
        loadCredential(config.LND_MACAROON_PATH, config.LND_MACAROON_HEX, 'hex'),
      ])
      return new LndRestProvider({
        url: config.LND_REST_URL,
        tlsCertificate: certificate,
        macaroon,
        timeoutMs: 8_000,
      })
    }
  }
}
