-- What the game knows that the WoW Assistant can't see: the character, and for each item
-- linked in a question, its tooltip and what's equipped in the same slot. It rides at the
-- end of a question to the assistant, after MARKER; the bridge leaves that part out of
-- the transcript the game shows.
--
-- Every game API is called through `try`: a call that's missing or errors on this client
-- just leaves its line out.

local _, ns = ...
local C = {}
ns.GameContext = C

C.MARKER = "[Game context]"
local MAX_ITEM_LINES = 14

local function ok(success, ...)
	if success then return ... end
end

local function try(fn, ...)
	if type(fn) ~= "function" then return nil end
	return ok(pcall(fn, ...))
end

-- Text without the game's markup: colors, links, textures and atlas icons.
function C.Plain(s)
	s = tostring(s or "")
	s = s:gsub("||", "\001")
	-- Colors: |cAARRGGBB, or |cn<name>: for a named color such as an item quality.
	s = s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|cn[^:|]*:", ""):gsub("|r", "")
	s = s:gsub("|H.-|h(.-)|h", "%1"):gsub("|T.-|t", ""):gsub("|A.-|a", ""):gsub("|n", " ")
	s = s:gsub("\001", "|")
	return s
end

-- The item links in `text`, in order and each once: { item = "item:…", name = "…" }.
function C.Links(text)
	local out, seen = {}, {}
	for item, name in tostring(text or ""):gmatch("|H(item:[^|]+)|h%[(.-)%]|h") do
		if not seen[item] then
			seen[item] = true
			table.insert(out, { item = item, name = name })
		end
	end
	return out
end

-- The text with each item link, and the color around it, as [Name]. Nothing else in
-- what the player typed changes.
function C.Clean(text)
	local s = tostring(text or "")
	s = s:gsub("|c%x%x%x%x%x%x%x%x|H(item:[^|]+)|h%[(.-)%]|h|r", "[%2]")
	s = s:gsub("|cn[^:|]*:|H(item:[^|]+)|h%[(.-)%]|h|r", "[%2]")
	s = s:gsub("|H(item:[^|]+)|h%[(.-)%]|h", "[%2]")
	return s
end

-- Shift-clicking an item while the message box has focus puts its link there, as it
-- would in a chat box. Hooked after the game's own handler, so chat keeps working.
function C.HookLinks()
	if C.hooked then return end
	local function insert(link)
		if type(link) ~= "string" then return end
		local ask = ns.AskPanel and ns.AskPanel.box
		if ask and ask:IsVisible() and ask:HasFocus() then
			ask:Insert(link)
			return
		end
		for _, view in ipairs(ns.ChatTab and ns.ChatTab.views or {}) do
			if view.Box:IsVisible() and view.Box:HasFocus() then
				view.Box:Insert(link)
				return
			end
		end
		local box = ns.Main and ns.Main.composer
		if box and box:IsVisible() and box:HasFocus() then ns.Suggest:InsertAtCursor(link) end
	end
	if ChatFrameUtil and type(ChatFrameUtil.InsertLink) == "function" then
		hooksecurefunc(ChatFrameUtil, "InsertLink", ns.Safe(insert))
		C.hooked = true
	elseif type(ChatEdit_InsertLink) == "function" then
		hooksecurefunc("ChatEdit_InsertLink", ns.Safe(insert))
		C.hooked = true
	end
end

-- Where an item goes, as inventory slot ids, so what's worn there can be compared.
local SLOTS = {
	INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 }, INVTYPE_BODY = { 4 },
	INVTYPE_CHEST = { 5 }, INVTYPE_ROBE = { 5 }, INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 },
	INVTYPE_FEET = { 8 }, INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 }, INVTYPE_FINGER = { 11, 12 },
	INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 }, INVTYPE_WEAPON = { 16, 17 },
	INVTYPE_2HWEAPON = { 16 }, INVTYPE_WEAPONMAINHAND = { 16 }, INVTYPE_WEAPONOFFHAND = { 17 },
	INVTYPE_SHIELD = { 17 }, INVTYPE_HOLDABLE = { 17 }, INVTYPE_RANGED = { 16, 18 },
	INVTYPE_RANGEDRIGHT = { 16, 18 }, INVTYPE_THROWN = { 18 }, INVTYPE_RELIC = { 18 },
}
C.SLOTS = SLOTS

local function equipLoc(item)
	local loc = C_Item and select(4, try(C_Item.GetItemInfoInstant, item))
	if not loc or loc == "" then loc = select(9, try(C_Item and C_Item.GetItemInfo or GetItemInfo, item)) end
	return loc ~= "" and loc or nil
end

-- One line naming an item: [Name] (item level 200, Head, Leather).
local function itemHeader(item, name)
	local bits = {}
	local ilvl = try(C_Item and C_Item.GetDetailedItemLevelInfo or GetDetailedItemLevelInfo, item)
	if ilvl then table.insert(bits, "item level " .. ilvl) end
	local loc = equipLoc(item)
	if loc and _G[loc] then table.insert(bits, _G[loc]) end
	local subType = C_Item and select(3, try(C_Item.GetItemInfoInstant, item))
	if subType and subType ~= "" then table.insert(bits, subType) end
	return "[" .. C.Plain(name) .. "]" .. (#bits > 0 and (" (" .. table.concat(bits, ", ") .. ")") or "")
end

-- The item's tooltip, without its name, flavor text and sell price; else its stats.
function C.ItemLines(item)
	local lines = {}
	local data = C_TooltipInfo and try(C_TooltipInfo.GetHyperlink, item)
	if type(data) == "table" and type(data.lines) == "table" then
		for i, line in ipairs(data.lines) do
			if i > 1 then
				local l, r = strtrim(C.Plain(line.leftText)), strtrim(C.Plain(line.rightText))
				local t = r ~= "" and (l .. "  " .. r) or l
				if t ~= "" and not t:find('^"') and not t:find("^Sell Price") then table.insert(lines, t) end
			end
			if #lines >= MAX_ITEM_LINES then break end
		end
	end
	if #lines == 0 then
		local stats = try(C_Item and C_Item.GetItemStats or GetItemStats, item)
		if type(stats) == "table" then
			for key, value in pairs(stats) do
				table.insert(lines, string.format("%s %s", tostring(value), C.Plain(_G[key] or key)))
			end
			table.sort(lines)
		end
	end
	return lines
end

function C.Character()
	local name = try(UnitName, "player") or "?"
	local level = try(UnitLevel, "player")
	local race = try(UnitRace, "player")
	local class = try(UnitClass, "player")
	local spec, role
	if C_SpecializationInfo then
		local index = try(C_SpecializationInfo.GetSpecialization)
		if index then
			local _, specName, _, _, specRole = try(C_SpecializationInfo.GetSpecializationInfo, index)
			spec, role = specName, specRole
		end
	end
	local parts = { "Character: " .. C.Plain(name) }
	local who = {}
	if level then table.insert(who, "level " .. level) end
	if race then table.insert(who, race) end
	if class then table.insert(who, class) end
	if #who > 0 then parts[1] = parts[1] .. ", " .. table.concat(who, " ") end
	if spec then table.insert(parts, "spec " .. spec .. (role and (" (" .. role .. ")") or "")) end
	local avg, equipped = try(GetAverageItemLevel)
	if equipped then table.insert(parts, string.format("equipped item level %.0f", equipped)) elseif avg then table.insert(parts, string.format("item level %.0f", avg)) end
	return table.concat(parts, ", ")
end

-- Where the player is: zone, subzone and map coordinates.
function C.Location()
	local zone = try(GetRealZoneText) or try(GetZoneText)
	if not zone or zone == "" then return nil end
	local sub = try(GetSubZoneText)
	local line = "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (", " .. sub) or "")
	if C_Map then
		local map = try(C_Map.GetBestMapForUnit, "player")
		local pos = map and try(C_Map.GetPlayerMapPosition, map, "player")
		local x, y
		if pos and pos.GetXY then x, y = ok(pcall(pos.GetXY, pos)) end
		if x and y and (x > 0 or y > 0) then line = line .. string.format(" (%.1f, %.1f)", x * 100, y * 100) end
	end
	return line
end

-- What the player has targeted: name, level, rank and type, friend or foe.
function C.Target()
	if not try(UnitExists, "target") then return nil end
	local name = try(UnitName, "target")
	if not name then return nil end
	local bits = {}
	local level = try(UnitLevel, "target")
	if level then table.insert(bits, level < 0 and "level ??" or ("level " .. level)) end
	local rank = try(UnitClassification, "target")
	if rank and rank ~= "normal" and rank ~= "minus" then table.insert(bits, rank) end
	local kind = try(UnitIsPlayer, "target") and (try(UnitClass, "target") or "player") or try(UnitCreatureType, "target")
	if kind then table.insert(bits, kind) end
	if try(UnitIsEnemy, "player", "target") then table.insert(bits, "hostile") elseif try(UnitIsFriend, "player", "target") then table.insert(bits, "friendly") end
	return "Target: " .. C.Plain(name) .. (#bits > 0 and (" (" .. table.concat(bits, ", ") .. ")") or "")
end

-- The quests the player follows: the one the map points to first, then tracked ones, each
-- with its objectives. Up to `max` quests.
function C.Quests(max)
	if not C_QuestLog or (max or 0) <= 0 then return {} end
	local ids, seen = {}, {}
	local function add(id)
		if id and id > 0 and not seen[id] then seen[id] = true table.insert(ids, id) end
	end
	if C_SuperTrack then add(try(C_SuperTrack.GetSuperTrackedQuestID)) end
	local watched = try(C_QuestLog.GetNumQuestWatches) or 0
	for i = 1, watched do add(try(C_QuestLog.GetQuestIDForQuestWatchIndex, i)) end
	local out = {}
	for _, id in ipairs(ids) do
		if #out >= max then break end
		local title = try(C_QuestLog.GetTitleForQuestID, id)
		if title then
			local done = try(C_QuestLog.ReadyForTurnIn, id) or try(C_QuestLog.IsComplete, id)
			local lines = { "Quest: " .. C.Plain(title) .. (done and " (ready to turn in)" or "") }
			for _, o in ipairs(try(C_QuestLog.GetQuestObjectives, id) or {}) do
				if type(o) == "table" and o.text and o.text ~= "" then
					table.insert(lines, "  " .. (o.finished and "[done] " or "") .. C.Plain(o.text))
				end
			end
			table.insert(out, table.concat(lines, "\n"))
		end
	end
	return out
end

-- The active talent loadout as its import string, which the assistant can decode, and
-- the loadout's name when the game says.
function C.Talents()
	if not C_ClassTalents or not C_Traits then return nil end
	local config = try(C_ClassTalents.GetActiveConfigID)
	if not config then return nil end
	local code = try(C_Traits.GenerateImportString, config)
	if not code or code == "" then return nil end
	local spec = C_SpecializationInfo and try(C_SpecializationInfo.GetSpecializationInfo, try(C_SpecializationInfo.GetSpecialization) or 0)
	local saved = spec and try(C_ClassTalents.GetLastSelectedSavedConfigID, spec)
	local info = saved and try(C_Traits.GetConfigInfo, saved)
	return "Talents" .. ((type(info) == "table" and info.name) and (" (" .. C.Plain(info.name) .. ")") or "") .. ": " .. code
end

-- The block for `text`: the character and where they are, then each linked item and what's
-- worn in its slot, then their tracked quests and talents. `level` says how much fits:
-- { items = lines per item, quests = how many, talents = true }.
function C.Block(text, level)
	level = level or C.LEVELS[1]
	local out = { C.MARKER, C.Character() }
	local function line(l) if l then table.insert(out, l) end end
	line(C.Location())
	line(C.Target())
	local shown = {}
	local function add(label, item, name)
		if shown[item] then return end
		shown[item] = true
		table.insert(out, label .. itemHeader(item, name))
		local lines = C.ItemLines(item)
		for i = 1, math.min(#lines, level.items) do table.insert(out, "  " .. lines[i]) end
	end
	for _, link in ipairs(C.Links(text)) do
		add("Linked: ", link.item, link.name)
		for _, slot in ipairs(SLOTS[equipLoc(link.item) or ""] or {}) do
			local worn = try(GetInventoryItemLink, "player", slot)
			local wornItem, wornName = tostring(worn or ""):match("|H(item:[^|]+)|h%[(.-)%]|h")
			if wornItem then add("Equipped now: ", wornItem, wornName) end
		end
	end
	for _, q in ipairs(C.Quests(level.quests)) do table.insert(out, q) end
	if level.talents then line(C.Talents()) end
	return table.concat(out, "\n")
end

-- From everything down to the character and location alone, tried in order until the
-- message fits.
C.LEVELS = {
	{ items = MAX_ITEM_LINES, quests = 4, talents = true },
	{ items = 8, quests = 3, talents = true },
	{ items = 4, quests = 2, talents = false },
	{ items = 0, quests = 1, talents = false },
	{ items = 0, quests = 0, talents = false },
}

-- The question as sent to the assistant: clean text, then as much context as `fits`
-- (a function of the full message) allows.
function C.Build(text, fits)
	local clean = C.Clean(text)
	for _, level in ipairs(C.LEVELS) do
		local message = clean .. "\n\n" .. C.Block(text, level)
		if not fits or fits(message) then return message end
	end
	return clean
end
