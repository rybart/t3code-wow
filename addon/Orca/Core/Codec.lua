-- Pixel strip codec, shared with bridge/src/codec.js. Pure Lua 5.1, no WoW APIs,
-- so tools/lua-tests can run it outside the game.
--
-- Frame bytes:
--   [0x54 'T'] [0x33 '3'] [version] [seq hi, lo] [len hi, lo] [payload ...] [fletcher s1, s2]
-- The checksum covers version..payload. Bytes are packed MSB-first into 3-bit cells,
-- each drawn as a square whose R, G and B channels are fully on or off (bit 2 = R,
-- bit 1 = G, bit 0 = B). Pure primaries survive gamma and contrast settings.

local _, ns = ...
ns = ns or {}

local Codec = {}
ns.Codec = Codec

Codec.MAGIC1, Codec.MAGIC2 = 0x54, 0x33
Codec.VERSION = 1 -- plaintext: only ever a bare hello
Codec.ENCRYPTED = 2 -- nonce .. ChaCha20 ciphertext .. tag, see Crypto.lua
Codec.SEAL_OVERHEAD = 20
Codec.BITS = 3
Codec.CELLS_PER_ROW = 160
Codec.MAX_ROWS = 40
Codec.HEADER_BYTES = 7
Codec.MAX_PAYLOAD = math.floor(Codec.CELLS_PER_ROW * Codec.MAX_ROWS * Codec.BITS / 8) - Codec.HEADER_BYTES - 2
Codec.US = "\031"
Codec.RS = "\030"

local floor = math.floor

function Codec.Fletcher16(bytes, from, to)
	local s1, s2 = 0, 0
	for i = from, to do
		s1 = (s1 + bytes[i]) % 255
		s2 = (s2 + s1) % 255
	end
	return s1, s2
end

-- Returns an array of cell values (0..7).
function Codec.Encode(seq, payload, version)
	local len = #payload
	if len > Codec.MAX_PAYLOAD then
		return nil, "payload too large"
	end
	seq = seq % 65536
	local bytes = {
		Codec.MAGIC1, Codec.MAGIC2, version or Codec.VERSION,
		floor(seq / 256), seq % 256,
		floor(len / 256), len % 256,
	}
	for i = 1, len do
		bytes[#bytes + 1] = payload:byte(i)
	end
	local s1, s2 = Codec.Fletcher16(bytes, 3, #bytes)
	bytes[#bytes + 1] = s1
	bytes[#bytes + 1] = s2

	local cells = {}
	local acc, nbits = 0, 0
	for i = 1, #bytes do
		acc = acc * 256 + bytes[i]
		nbits = nbits + 8
		while nbits >= 3 do
			local shift = nbits - 3
			local p = 2 ^ shift
			cells[#cells + 1] = floor(acc / p) % 8
			nbits = shift
			acc = acc % p
		end
	end
	if nbits > 0 then
		cells[#cells + 1] = (acc * 2 ^ (3 - nbits)) % 8
	end
	return cells
end

function Codec.CellColor(v)
	return floor(v / 4) % 2, floor(v / 2) % 2, v % 2
end

-- Field/record helpers. Fields can't contain the separators; replace them.
function Codec.Clean(s)
	s = tostring(s or "")
	return (s:gsub("[\030\031]", " "))
end

function Codec.Record(fields)
	local out = {}
	for i = 1, #fields do
		out[i] = Codec.Clean(fields[i])
	end
	return table.concat(out, Codec.US)
end

return Codec
