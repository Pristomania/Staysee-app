#!/usr/bin/env bash
# One additional device on the existing legacy AWG container; no service restart.
set -euo pipefail
umask 077
[[ $EUID == 0 && ${1:-} =~ ^[A-Za-z0-9+/]{550,570}={0,2}$ ]]
exec 9>/run/lock/staysee-awg-profile.lock
flock -n 9
temp=$(mktemp -d)
trap 'find "$temp" -maxdepth 1 -type f -delete; rmdir "$temp"' EXIT
c=amnezia-awg
conf=/opt/amnezia/awg/wg0.conf
printf '%s' "$1" | base64 -d | openssl pkey -inform DER -pubin -out "$temp/public.pem"
bin=$(docker exec "$c" sh -c 'if command -v awg >/dev/null && test -n "$(awg show interfaces 2>/dev/null)"; then echo awg; else command -v wg >/dev/null && echo wg; fi')
[[ "$bin" == awg || "$bin" == wg ]]
iface=$(docker exec "$c" "$bin" show interfaces | xargs)
[[ "$iface" =~ ^(wg0|awg0)$ ]]
docker exec "$c" cat "$conf" > "$temp/server.conf"
docker exec "$c" "$bin" show "$iface" allowed-ips > "$temp/peers"
before=$(sha256sum "$temp/server.conf" | cut -d' ' -f1)
port=$(docker exec "$c" "$bin" show "$iface" listen-port)
[[ "$port" == 39238 ]]
docker port "$c" "$port/udp" | grep -Fxq "0.0.0.0:$port"
server_key=$(docker exec "$c" "$bin" show "$iface" public-key)
docker exec "$c" "$bin" genkey > "$temp/client-key"
docker exec "$c" "$bin" genpsk > "$temp/client-psk"
pub=$(docker exec -i "$c" "$bin" pubkey < "$temp/client-key")
[[ "$pub" =~ ^[A-Za-z0-9+/]{43}=$ && "$server_key" =~ ^[A-Za-z0-9+/]{43}=$ ]]
printf '%s\n%s\n' "$pub" "$server_key" > "$temp/public-keys"
python3 - "$temp" "$port" <<'PY'
import ipaddress as ip, pathlib, sys, re
p = pathlib.Path(sys.argv[1])
cfg = (p/'server.conf').read_text()
sections = re.split(r'^\s*\[', cfg, flags=re.M)
interface, = (s for s in sections if s.startswith('Interface]'))
fields = dict((k.lower(), v.strip()) for k,v in re.findall(r'^\s*([a-zA-Z0-9]+)\s*=\s*([^#\n]+)', interface, re.M))
if fields.get('saveconfig', '').lower() == 'true': raise ValueError('Unexpected SaveConfig')
obfs_names = 'Jc Jmin Jmax S1 S2 H1 H2 H3 H4'.split()
assert all(re.fullmatch(r'\d+', fields.get(k.lower(),'')) for k in obfs_names), 'Expected legacy AmneziaWG fields'
assert not any(k in fields for k in 's3 s4 i1 i2 i3 i4 i5'.split()), 'Unsupported AWG profile'
server = next(ip.ip_interface(a.strip()) for a in fields['address'].split(',') if ':' not in a)
assert 2 <= server.network.num_addresses <= 4096
used = []
for raw in re.findall(r'^\s*AllowedIPs\s*=\s*([^#\n]+)', cfg, re.M):
    used.extend(ip.ip_network(a.strip(), strict=False) for a in raw.split(','))
for row in (p/'peers').read_text().splitlines():
    for a in row.split()[1:]:
        if a != '(none)': used.append(ip.ip_network(a.rstrip(','), strict=False))
address = next(x for x in server.network.hosts() if x != server.ip and all(x not in n for n in used))
priv = (p/'client-key').read_text().strip()
psk = (p/'client-psk').read_text().strip()
client_pub, server_pub = (p/'public-keys').read_text().splitlines()
assert all(re.fullmatch(r'[A-Za-z0-9+/]{43}=', k) for k in (priv,psk))
obfs = '\n'.join(f'{k} = {fields[k.lower()]}' for k in obfs_names)
(p/'phone.conf').write_text(f'[Interface]\nPrivateKey = {priv}\nAddress = {address}/32\nDNS = 1.1.1.1\nMTU = 1376\n{obfs}\n\n[Peer]\nPublicKey = {server_pub}\nPresharedKey = {psk}\nEndpoint = 78.17.147.119:{sys.argv[2]}\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25\n')
(p/'updated.conf').write_text(cfg.rstrip()+f'\n\n# Test phone {sys.argv[2]}\n[Peer]\nPublicKey = {client_pub}\nPresharedKey = {psk}\nAllowedIPs = {address}/32\n')
(p/'address').write_text(str(address))
PY
addr=$(<"$temp/address")
[[ "$addr" =~ ^[0-9.]+$ ]]
split -b 220 -d "$temp/phone.conf" "$temp/chunk-"
for file in "$temp"/chunk-*; do
    openssl pkeyutl -encrypt -pubin -inkey "$temp/public.pem" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in "$file" | base64 -w0
    echo
done > "$temp/sealed"
if ! docker exec -i "$c" sh -ceu '
    umask 077; key=$(mktemp); trap '\''rm -f -- "$key"'\'' EXIT
    cat > "$key"
    "$1" set "$2" peer "$3" preshared-key "$key" allowed-ips "$4/32"
' sh "$bin" "$iface" "$pub" "$addr" < "$temp/client-psk"; then exit 1; fi
if ! docker exec -i "$c" sh -ceu '
    umask 077; cfg=$1; wanted=$2; actual=$(sha256sum "$cfg"); test "${actual%% *}" = "$wanted"
    tmp=$(mktemp "${cfg}.candidate.XXXXXX"); trap '\''rm -f -- "$tmp"'\'' EXIT
    cat > "$tmp"; test -s "$tmp"
    backup="${cfg}.before-phone-$(date +%s)"
    test ! -e "$backup"; cp -p "$cfg" "$backup"
    mv "$tmp" "$cfg"
' sh "$conf" "$before" < "$temp/updated.conf"; then
    docker exec "$c" "$bin" set "$iface" peer "$pub" remove
    exit 1
fi
docker exec "$c" "$bin" show "$iface" allowed-ips | awk -v key="$pub" -v subnet="$addr/32" '$1==key && $2==subnet{found=1} END{exit !found}'
docker exec "$c" grep -Fxq "PublicKey = $pub" "$conf"
while IFS= read -r chunk; do printf 'AWG_SEALED:%s\n' "$chunk"; done < "$temp/sealed"
echo 'AWG_PEER_VERIFIED: live and persistent; old peers unchanged; no restart'
