export const domain = (() => {
  if ($app.stage === "production") return "ocpp.ai"
  if ($app.stage === "dev") return "dev.ocpp.ai"
  return `${$app.stage}.dev.ocpp.ai`
})()

// Cloudflare zone plus the trust-center records below are still the accounts and
// verification tokens inherited from the upstream deployment. Deploying OC++ needs
// the zone for `domain` and freshly issued vendor tokens.
export const zoneID = "430ba34c138cfb5360826c4909f99be8"
export const awsStage = $app.stage === "production" ? "production" : "dev"
export const deployAws = $app.stage === awsStage

if ($app.stage === "production") {
  new cloudflare.DnsRecord("TrustCenter", {
    zoneId: zoneID,
    name: "trust.ocpp.ai",
    type: "CNAME",
    content: "3a69a5bb27875189.vercel-dns-016.com",
    proxied: false,
    ttl: 60,
  })

  new cloudflare.DnsRecord("TrustCenterVerification", {
    zoneId: zoneID,
    name: "ocpp.ai",
    type: "TXT",
    content: "compai-domain-verification=org_6993a99c6200a2d642bb115d",
    ttl: 60,
  })
}

new cloudflare.RegionalHostname("RegionalHostname", {
  hostname: domain,
  regionKey: "us",
  zoneId: zoneID,
})

// Share links used to live on a separate shortener domain; OC++ serves them from the
// product domain until a dedicated short domain exists.
export const shortDomain = domain
