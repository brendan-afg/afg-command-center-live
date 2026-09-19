import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = pair.publicKey.export({ format: "jwk" });
const privateJwk = pair.privateKey.export({ format: "jwk" });
const fragment = Buffer.from(JSON.stringify(privateJwk), "utf8").toString("base64url");
await fs.writeFile(path.join(root, "recipient-public-key.json"), `${JSON.stringify(publicJwk, null, 2)}\n`, { mode: 0o644 });
const privatePath = "/home/ubuntu/afg-command-center-daily-private-key.txt";
await fs.writeFile(privatePath, `${fragment}\n`, { mode: 0o600 });
await fs.chmod(privatePath, 0o600);
console.log("Generated dashboard recipient keypair; private key saved outside the repository.");
