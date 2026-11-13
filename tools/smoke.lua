-- Headless smoke test: load the addon against tools/wowstub.lua and drive it.
--   lua5.1 tools/smoke.lua <addon dir> <snapshot.lua> [viewId]
local addonDir, snapshot, viewId = arg[1], arg[2], arg[3]
package.path = "./tools/?.lua;" .. package.path
local Stub = dofile("tools/wowstub.lua")
Stub.slotData.default = snapshot

local function check(cond, msg)
	if not cond then for _, e in ipairs(Orca and Orca.errors or {}) do print("RECORDED ERROR: " .. e.msg) end error("CHECK FAILED: " .. msg, 2) end
	print("ok - " .. msg)
end

-- Load files in TOC order.
local ns = {}
for line in io.lines(addonDir .. "/Orca.toc") do
	line = line:gsub("\r", "")
	if line ~= "" and not line:match("^#") and line:match("%.lua$") then
		local path = addonDir .. "/" .. line:gsub("\\", "/")
		local chunk = assert(loadfile(path))
		chunk("Orca", ns)
	end
end
check(Orca == ns, "namespace exported")

Stub.Fire("ADDON_LOADED", "Orca")
check(ns.db and ns.db.session and #ns.db.session == 8, "saved variables initialised")
Stub.Fire("PLAYER_LOGIN")
check(ns.Transport.slotCount == 600, "found 600 slots by binary search")
check(ns.Store.applied == 1, "bootstrap slot applied")
check(#ns.Store.data.threads > 0, "threads loaded: " .. #ns.Store.data.threads)
check(ns.Transport.stripShown, "hello strip shown")
check(ns.Transport:Encrypted(), "link keys loaded from the bootstrap slot")
check(Orca_Inbox == nil, "slot global cleared after loading")
do
	local drawn = WOWSTUB.StripCells()
	-- Header byte 3 (version) spans cells 6..8: bits 16..23 of the frame.
	local bits = {}
	for i = 1, 9 do local v = drawn[i] bits[#bits + 1] = math.floor(v / 4) % 2 bits[#bits + 1] = math.floor(v / 2) % 2 bits[#bits + 1] = v % 2 end
	local version = 0
	for i = 17, 24 do version = version * 2 + bits[i] end
	check(version == 2, "strip is drawn encrypted (frame version 2)")
end
local payload = ns.Transport:Payload()
check(payload:sub(1, 2) == "H\031", "payload starts with hello record")

-- Strip encodes within capacity and the cells are valid.
local cells = ns.Codec.Encode(ns.Transport.stripSeq, payload)
check(#cells > 0, "strip cells: " .. #cells)

-- Simulate the bridge acknowledging the hello via the next slot.
Stub.validSounds = {}
ns.Transport.signals = "ok"
local sig = ns.db.sigNext
-- Patch the snapshot's ack to this UI session.
local chunk = assert(loadfile(snapshot))
chunk()
local data = Orca_Inbox
Orca_Inbox = nil
data.ack = { ui = ns.ui, seq = ns.Transport.stripSeq }
-- The harness edits the snapshot in place, so its hashes (x) would no longer describe
-- what it carries. Without them every snapshot counts as complete, as an older bridge's
-- did; the test below drives the "this part is unchanged" path with its own hashes.
data.x = nil
data.gen = data.gen + 1
data.nextSig = sig + 1
ns.Transport:Apply(data)
check(not ns.Transport.stripShown, "strip hidden after ack")

-- Open the window, select a thread, render.
ns.Main:Open()
check(ns.windowOpen, "window open")
check(ns.Transport.stripShown, "window open bumps the strip")
local firstThread = ns.Store.data.threads[1]
ns.Main:SelectThread(viewId ~= "" and viewId or firstThread.id)
check(ns.viewId ~= nil, "thread selected")
ns.Store:Apply(data) -- view arrives
local rows = ns.Transcript.scrollBox._rows or {}
check(#rows > 0, "transcript rendered " .. #rows .. " elements")
local listRows = ns.ThreadList.scrollBox._rows or {}
check(#listRows > 0, "thread list rendered " .. #listRows .. " rows")

-- A snapshot may leave out the transcript and the project list when the bridge knows,
-- from the hello, that this addon already has them. It names them in `same`.
do
	local view = ns.Store.data.view
	local projects = ns.Store.data.projects
	data.gen = data.gen + 1
	ns.Transport:Apply({
		gen = data.gen, x = { l = "L1", p = "P1", v = "V1" },
		threads = ns.Store.data.threads, projects = projects, view = view,
		bridge = ns.Store.data.bridge, usage = ns.Store.data.usage,
		ack = { ui = ns.ui, seq = ns.Transport.stripSeq },
	})
	check(ns.Store.listKey == "L1" and ns.Store.projectsKey == "P1" and ns.Store.viewKey == "V1", "the addon records what it applied")
	rows = ns.Transcript.scrollBox._rows or {}
	local dpBefore = ns.Transcript.dp
	data.gen = data.gen + 1
	ns.Transport:Apply({
		gen = data.gen, same = "pv", x = { l = "L2", p = "P2", v = "V2" },
		threads = ns.Store.data.threads, bridge = ns.Store.data.bridge, usage = ns.Store.data.usage,
		ack = { ui = ns.ui, seq = ns.Transport.stripSeq },
	})
	check(ns.Store.data.view == view, "an omitted transcript is kept")
	check(ns.Store.data.projects == projects, "an omitted project list is kept")
	check(ns.Store.listKey == "L2" and ns.Store.projectsKey == "P1" and ns.Store.viewKey == "V1", "it only claims the parts it was sent")
	check(ns.Transport:Payload():find("\031L2\031P1\031V1", 1, true) ~= nil, "the hello reports what it holds")
	check(#(ns.Transcript.scrollBox._rows or {}) == #rows and ns.Transcript.dp == dpBefore, "the transcript isn't rebuilt for an unchanged one")

	-- Dropping the transcript must drop the hash too, and tell the bridge, or it would
	-- think the addon still has it and never send it again (Back, then the same thread).
	data.gen = data.gen + 1
	ns.Transport:Apply({
		gen = data.gen, x = { l = "L3", p = "P1", v = "" },
		threads = ns.Store.data.threads, projects = ns.Store.data.projects,
		bridge = ns.Store.data.bridge, usage = ns.Store.data.usage,
		ack = { ui = ns.ui, seq = ns.Transport.stripSeq },
	})
	check(ns.Store.data.view == nil and ns.Store.viewKey == "", "a dropped transcript is not claimed")

	-- Settling or reopening a thread changes the rows (quick replies) without the
	-- transcript changing, so its hash alone can't decide a redraw.
	ns.Store:Apply({
		x = { l = "L4", p = "P1", v = "V1" }, same = "v",
		threads = ns.Store.data.threads, projects = ns.Store.data.projects, bridge = ns.Store.data.bridge, usage = ns.Store.data.usage,
	})
	local dp = ns.Transcript.dp
	local thread = ns.Store:Thread(ns.viewId)
	local was = thread.s
	thread.s = was == "open" and "settled" or "open"
	ns.Store:Apply({
		x = { l = "L5", p = "P1", v = "V1" }, same = "v",
		threads = ns.Store.data.threads, projects = ns.Store.data.projects, bridge = ns.Store.data.bridge, usage = ns.Store.data.usage,
	})
	check(ns.Transcript.dp ~= dp, "a status change still redraws the transcript")
	thread.s = was
	-- Back to a complete snapshot for the rest of the checks.
	ns.Store:Apply(data)
end

-- Orca (the bridge says `orca`): no Settle, screenshots, commands or usage tab. A chat
-- agent takes replies; one in a terminal (its row's `ro`) is watch only. The rest of the
-- checks run as with T3 Code, where all of those work.
do
	data.bridge = data.bridge or {}
	data.bridge.orca = true
	ns.Store:Apply(data)
	ns.Main:Refresh()
	local f = ns.Main.frame
	check(f.Bar.Send:IsEnabled(), "Orca: Send is on for a chat agent")
	check(f.Bar.Stop:IsShown() and f.Bar.Shot:IsShown() and not f.Bar.Insert:IsShown(), "Orca: Stop and screenshots stay, commands are hidden")
	check(f.Bar.Ask:IsShown(), "Orca: the Ask button shows")
	check(not f.Tabs[2]:IsShown(), "Orca: the usage tab is hidden")
	check(not f.Pages.threads.Right.Header.Action:IsShown(), "Orca: Settle is hidden")
	local row = ns.Store:Thread(ns.viewId)
	row.ro = true
	ns.Main:Refresh()
	local queued = #ns.Transport.queue
	ns.Main.composer._text = "hello"
	ns.Main:Send()
	check(#ns.Transport.queue == queued, "Orca: a reply to a terminal agent isn't sent")
	check(not f.Bar.Send:IsEnabled() and not f.Bar.Stop:IsEnabled(), "Orca: Send and Stop are off for a terminal agent")
	row.ro = nil
	-- Ask: with no assistant yet the bridge is asked to start it; once it exists, Ask
	-- opens its thread and sends the question there.
	local view = ns.viewId
	queued = #ns.Transport.queue
	ns.Main:OpenAssistant("why is my game so dark?")
	local last = ns.Transport.queue[#ns.Transport.queue]
	check(#ns.Transport.queue == queued + 1 and last.verb == "assistant" and last.args[1]:find("^why is my game so dark%?\n\n%[Game context%]\nCharacter: ") ~= nil and ns.Main.pendingNew == last.id, "Ask with no assistant asks the bridge to start one, with the question and the character")
	table.remove(ns.Transport.queue)
	ns.Main.pendingNew = nil
	data.bridge.asst = view
	ns.Store:Apply(data)
	ns.Main:SelectThread(data.threads[#data.threads].id)
	ns.Main:OpenAssistant("and my gamma?")
	last = ns.Transport.queue[#ns.Transport.queue]
	check(ns.viewId == view and last.verb == "send" and last.args[1] == view and last.args[2]:find("^and my gamma%?\n\n%[Game context%]") ~= nil, "Ask opens the assistant and sends the question to it")
	table.remove(ns.Transport.queue)
	ns.Main:SelectThread(view)
	data.bridge.asst = nil
	data.bridge.orca = nil
	ns.Store:Apply(data)
	ns.Main:Refresh()
	check(f.Bar.Shot:IsShown() and f.Tabs[2]:IsShown() and not f.Bar.Ask:IsShown(), "with T3 Code, the usage tab comes back and Ask goes")
	ns.Main.composer._text = ""
end

-- Questions to the WoW Assistant carry game context: the character, each linked item's
-- tooltip and what's worn in its slot. Game APIs are faked here; the client's own
-- addons (Plumber, Leatrix, Syndicator) are where their shapes come from.
do
	local saved = {}
	local function fake(name, value) saved[name] = _G[name] _G[name] = value end
	local LINK_A = "|cnIQ4:|Hitem:1001::::::::60:::::|h[Helm of Testing]|h|r"
	local LINK_WORN = "|cnIQ3:|Hitem:2002::::::::60:::::|h[Old Cap]|h|r"
	fake("UnitName", function() return "Tester" end)
	fake("UnitLevel", function() return 60 end)
	fake("UnitRace", function() return "Night Elf" end)
	fake("UnitClass", function() return "Druid" end)
	fake("GetAverageItemLevel", function() return 182.4, 180.2 end)
	fake("C_SpecializationInfo", { GetSpecialization = function() return 1 end, GetSpecializationInfo = function() return 102, "Balance", "", 0, "DAMAGER" end })
	fake("INVTYPE_HEAD", "Head")
	fake("C_Item", {
		GetItemInfoInstant = function(item) return 1001, "Armor", "Leather", "INVTYPE_HEAD" end,
		GetDetailedItemLevelInfo = function(item) return item:find("1001") and 200 or 190 end,
	})
	fake("C_TooltipInfo", { GetHyperlink = function(item)
		local name = item:find("1001") and "Helm of Testing" or "Old Cap"
		return { lines = { { leftText = name }, { leftText = "Head", rightText = "Leather" }, { leftText = "|cffffffff+120 Intellect|r" }, { leftText = '"Smells of pine."' }, { leftText = "Sell Price: 5g" } } }
	end })
	fake("GetInventoryItemLink", function(unit, slot) return slot == 1 and LINK_WORN or nil end)

	local block = ns.GameContext.Build("Is " .. LINK_A .. " better than mine?")
	check(block:find("^Is %[Helm of Testing%] better than mine%?\n\n%[Game context%]\n") ~= nil, "Ask: a link becomes [Name], and the context follows the marker")
	check(block:find("Character: Tester, level 60 Night Elf Druid, spec Balance %(DAMAGER%), equipped item level 180", 1) ~= nil, "Ask: the character line names level, race, class, spec and item level")
	check(block:find("Linked: [Helm of Testing] (item level 200, Head, Leather)", 1, true) ~= nil and block:find("  +120 Intellect", 1, true) ~= nil, "Ask: a linked item carries its level, slot, type and stats, without markup")
	check(block:find("Equipped now: [Old Cap] (item level 190", 1, true) ~= nil, "Ask: what's worn in the same slot comes along")
	check(not block:find("Smells of pine", 1, true) and not block:find("Sell Price", 1, true), "Ask: flavor text and sell price are left out")
	-- Where they are, their target, tracked quests and talents.
	fake("GetRealZoneText", function() return "Elwynn Forest" end)
	fake("GetSubZoneText", function() return "Goldshire" end)
	fake("C_Map", { GetBestMapForUnit = function() return 37 end, GetPlayerMapPosition = function() return { GetXY = function() return 0.42, 0.6588 end } end })
	fake("UnitExists", function(u) return u == "target" end)
	local realUnitName, realUnitLevel = UnitName, UnitLevel
	fake("UnitName", function(u) return u == "target" and "Hogger" or "Tester" end)
	fake("UnitLevel", function(u) return u == "target" and 11 or 60 end)
	fake("UnitClassification", function() return "elite" end)
	fake("UnitIsPlayer", function() return false end)
	fake("UnitCreatureType", function() return "Humanoid" end)
	fake("UnitIsEnemy", function() return true end)
	fake("C_SuperTrack", { GetSuperTrackedQuestID = function() return 176 end })
	fake("C_QuestLog", {
		GetNumQuestWatches = function() return 2 end,
		GetQuestIDForQuestWatchIndex = function(i) return i == 1 and 176 or 33 end,
		GetTitleForQuestID = function(id) return id == 176 and "Wanted: \"Hogger\"" or "Wolves Across the Border" end,
		ReadyForTurnIn = function(id) return id == 33 end,
		GetQuestObjectives = function(id) return id == 176 and { { text = "Huge Gnoll Claw: 0/1", finished = false } } or { { text = "Tough Wolf Meat: 8/8", finished = true } } end,
	})
	fake("C_ClassTalents", { GetActiveConfigID = function() return 9 end, GetLastSelectedSavedConfigID = function() return 12 end })
	fake("C_Traits", { GenerateImportString = function() return "BYGAAAAAAAAAAAAAAAAAAAAAAAAQ" end, GetConfigInfo = function() return { name = "Leveling" } end })
	local full = ns.GameContext.Build("Where do I go?")
	check(full:find("Location: Elwynn Forest, Goldshire (42.0, 65.9)", 1, true) ~= nil, "Ask: the location names zone, subzone and coordinates")
	check(full:find("Target: Hogger (level 11, elite, Humanoid, hostile)", 1, true) ~= nil, "Ask: the target names level, rank, type and stance")
	check(full:find('Quest: Wanted: "Hogger"\n  Huge Gnoll Claw: 0/1', 1, true) ~= nil and full:find("Quest: Wolves Across the Border (ready to turn in)\n  [done] Tough Wolf Meat: 8/8", 1, true) ~= nil, "Ask: tracked quests come with their objectives, the map's quest first")
	check(full:find("Talents (Leveling): BYGAAAAAAAAAAAAAAAAAAAAAAAAQ", 1, true) ~= nil, "Ask: the talent loadout rides along as its import string")
	local trimmed = ns.GameContext.Build("Where do I go?", function(m) return #m < #full - 40 end)
	check(not trimmed:find("Talents", 1, true) and trimmed:find("Location:", 1, true) ~= nil, "Ask: talents go before the location when space is short")
	_G.UnitName, _G.UnitLevel = realUnitName, realUnitLevel
	fake("UnitExists", function() return false end)
	fake("C_QuestLog", nil)
	fake("C_ClassTalents", nil)
	fake("GetRealZoneText", nil)
	fake("C_Map", nil)
	local cut = ns.GameContext.Build("Better? " .. LINK_A, function(m) return #m < 260 end)
	check(#cut < 260 and cut:find("Linked: [Helm of Testing]", 1, true) ~= nil and not cut:find("+120 Intellect", 1, true), "Ask: a long block drops item lines to fit, keeping the items")
	check(ns.GameContext.Clean("a || b " .. LINK_A) == "a || b [Helm of Testing]", "Ask: cleaning changes only links")

	-- Shift-click: the game's InsertLink, hooked, fills the message box while it has focus.
	fake("ChatFrameUtil", { InsertLink = function() return false end })
	ns.GameContext.hooked = nil
	ns.GameContext.HookLinks()
	ns.Main.composer._text = "compare"
	ns.Main.composer:SetFocus()
	ChatFrameUtil.InsertLink(LINK_A)
	check(ns.Main.composer:GetInputText() == "compare " .. LINK_A .. " ", "Ask: shift-clicking an item puts its link in the focused message box")
	ns.Main.composer:ClearFocus()
	ChatFrameUtil.InsertLink(LINK_WORN)
	check(ns.Main.composer:GetInputText() == "compare " .. LINK_A .. " ", "Ask: without focus, the link goes where the game sends it, not here")

	-- Sending to the assistant's thread carries the block; other agents get [Name] only.
	data.bridge.asst = ns.viewId
	data.bridge.orca = true
	ns.Store:Apply(data)
	ns.Main.composer._text = "Better? " .. LINK_A
	ns.Main:Send()
	local last = ns.Transport.queue[#ns.Transport.queue]
	check(last.verb == "send" and last.args[2]:find("[Game context]", 1, true) ~= nil and not last.args[2]:find("|H", 1, true), "Ask: a question to the assistant carries the game context")
	table.remove(ns.Transport.queue)
	data.bridge.asst, data.bridge.orca = nil, nil
	ns.Store:Apply(data)
	ns.Main.composer._text = "Look at " .. LINK_A
	ns.Main:Send()
	last = ns.Transport.queue[#ns.Transport.queue]
	check(last.args[2] == "Look at [Helm of Testing]", "Ask: other agents get the item's name, no context")
	table.remove(ns.Transport.queue)
	ns.Main.composer._text = ""
	for name, value in pairs(saved) do _G[name] = value end
	ns.GameContext.hooked = nil
end

-- Pull requests: a row's PR in a few words, a notice when its checks fail or it merges,
-- once per PR though several agents share it.
do
	local S = ns.Store
	check(S.PRChange({ n = 5, s = "open", c = "pending" }, { n = 5, s = "open", c = "failure" }) == "prfail", "PR: checks failing is a notice")
	check(S.PRChange({ n = 5, s = "open", c = "pending" }, { n = 5, s = "open", c = "success" }) == "prpass", "PR: checks passing is a notice")
	check(S.PRChange({ n = 5, s = "open", c = "success" }, { n = 5, s = "merged", c = "success" }) == "merged", "PR: merging is a notice")
	check(S.PRChange(nil, { n = 5, s = "open", c = "failure" }) == nil and S.PRChange({ n = 5, s = "open", c = "failure" }, { n = 5, s = "open", c = "failure" }) == nil, "PR: a first sighting or no change is quiet")
	check(S.PRText({ n = 12, s = "open", c = "failure" }):find("PR #12 failing", 1, true) ~= nil, "PR: a failing PR reads as failing")
	local fired = {}
	local off = ns:On("PRTransition", function(t, kind) table.insert(fired, kind) end)
	-- Each snapshot is a fresh table, as one from the bridge would be.
	local function withPR(pr)
		local copy = {}
		for k, v in pairs(data) do copy[k] = v end
		copy.threads = {}
		for i, t in ipairs(data.threads) do
			local row = {}
			for k, v in pairs(t) do row[k] = v end
			if i <= 2 then row.pr = { n = pr.n, s = pr.s, c = pr.c } end
			copy.threads[i] = row
		end
		return copy
	end
	ns.Store:Apply(withPR({ n = 77, s = "open", c = "pending" }))
	ns.Store:Apply(withPR({ n = 77, s = "open", c = "failure" }))
	check(#fired == 1 and fired[1] == "prfail", "PR: two agents on one PR make one notice")
	ns.Store:Apply(data)
	local a, b = data.threads[1], data.threads[2]
	-- An Orca update that may break replies: one chat line, and the status line says so.
	local warned = 0
	ns:On("BridgeWarning", function() warned = warned + 1 end)
	local function withWarn(warn)
		local bridge = {}
		for k, v in pairs(data.bridge) do bridge[k] = v end
		bridge.warn = warn
		local copy = {}
		for k, v in pairs(data) do copy[k] = v end
		copy.bridge = bridge
		ns.Store:Apply(copy)
	end
	withWarn("Orca 1.5.0 changed how chats work")
	withWarn("Orca 1.5.0 changed how chats work")
	check(warned == 1, "Orca update: the warning is said once")
	check(ns.Main:StatusLine():find("replies may fail", 1, true) ~= nil, "Orca update: the status line warns")
	withWarn(nil)
	ns.Store:Apply(data)
	-- Logging in: a summary when agents finished or need you.
	local printed
	local realPrint, realAfter = ns.Print, C_Timer.After
	ns.Print = function(msg) printed = msg end
	C_Timer.After = function(_, fn) fn() end
	local was = { a.s, a.un, b.s }
	a.s, a.un, b.s = "open", true, "input"
	ns.Store.liveSeen = nil
	data.ack = { ui = ns.ui, seq = 0 }
	ns.Store:Apply(data)
	check(printed and printed:find("While you were away", 1, true) ~= nil and printed:find("1 agent finished", 1, true) ~= nil and printed:find("1 needs you", 1, true) ~= nil, "Away: the first live update sums up what finished and what needs you")
	printed = nil
	ns.Store:Apply(data)
	check(printed == nil, "Away: only once per session")
	ns.Print, C_Timer.After = realPrint, realAfter
	a.s, a.un, b.s = was[1], was[2], was[3]
	data.ack = nil
	ns.Store:Apply(data)
end

-- Send a message: queued, echoed, and present in the strip payload.
-- A message too long for one frame would never go and would hold up the queue behind it.
do
	local queued = #ns.Transport.queue
	ns.Main.composer._text = string.rep("x", 2300)
	ns.Main:Send()
	check(#ns.Transport.queue == queued and #ns.Main.composer._text == 2300, "a message too long for the strip is refused, and the composer keeps it")
	ns.Main.composer._text = string.rep("x", 1900)
	ns.Main:Send()
	check(#ns.Transport.queue == queued + 1, "a long message that fits still goes")
	table.remove(ns.Transport.queue)
	ns.Transcript.echo[ns.viewId] = nil
end
ns.Main.composer._text = "Please run the tests"
ns.Main:Send()
check(#ns.Transport.queue >= 1, "command queued")
check(ns.Transport:Payload():find("Please run the tests", 1, true) ~= nil, "message in strip payload")
check(ns.Transport.queue[#ns.Transport.queue].args[3] == "steer", "follow-ups ask to steer by default")
ns.db.settings.steerFollowUps = false
ns.Main:Send("And the linter")
check(ns.Transport.queue[#ns.Transport.queue].args[3] == nil, "with steering off, a follow-up names no mode, so the bridge queues it")
ns.db.settings.steerFollowUps = true
check(ns.Transcript.echo[ns.viewId] ~= nil, "local echo shown")
-- The bridge reformats what you sent (markdown, escapes); the echo still goes when it arrives.
do
	local v = ns.Store.data.view
	if v and v.id == ns.viewId then
		local last = 0
		for _, m in ipairs(v.msgs or {}) do last = math.max(last, m.at or 0) end
		-- T3 Code renumbers its bounded window, so the new message can have a lower number.
		table.insert(v.msgs, { r = "u", t = "|cffa8c7fa  reformatted|r", at = last + 1, n = 1 })
		ns.Transcript:Refresh(true)
		check(ns.Transcript.echo[ns.viewId] == nil, "local echo dropped once the sent message arrives, reformatted")
		table.remove(v.msgs)
	end
end

-- Pages
ns.Main:ShowPage("usage")
ns.Main:ShowPage("settings")
ns.Main:ShowPage("threads")
check(true, "pages switch")

-- New thread flow
ns.Main:StartNewThread()
check(ns.Main.mode == "new" and ns.Main.newProject ~= nil, "new thread mode with project " .. tostring(ns.Main.newProject))
local hdr = ns.Main.frame.Pages.threads.Right.Header
check(ns.Transport:Payload():find(ns.Store.modelsHash, 1, true) ~= nil and ns.Store.modelsHash ~= "", "hello reports the model list it has: " .. ns.Store.modelsHash)
local function Choices(dd)
	local list = {}
	for _, o in ipairs(dd.options) do if not o.header then table.insert(list, o) end end
	return list
end
local groups = {}
for _, o in ipairs(hdr.Model.options) do if o.header then table.insert(groups, o.label) end end
check(hdr.Model:IsShown() and #Choices(hdr.Model) >= 1, "model picker shown for a new thread: " .. #Choices(hdr.Model) .. " models")
check(hdr.Model.options[1].header and #groups >= 2, "models grouped under headers: " .. table.concat(groups, ", "))
check(hdr.Model.Text:GetText():find(" · ", 1, true) ~= nil, "the button names the provider: " .. hdr.Model.Text:GetText())
do
	-- A search for a provider keeps its header and its models; headers aren't choices.
	local provider = groups[#groups]
	ns.UI.OpenList(hdr.Model)
	local l = ns.UI.ListOpen()
	l.Search:SetText(provider:lower())
	ns.UI.RefreshList()
	local at, others
	for n, o in ipairs(l.filtered) do
		if o.header and o.label == provider then at = n end
		-- Another provider's model may match on its own name ("GPT-5 Codex" under OpenCode, say).
		if not o.header and o.group ~= provider and o.group ~= "Recent" and not o.label:lower():find(provider:lower(), 1, true) then others = true end
	end
	check(at and l.filtered[at + 1] and not l.filtered[at + 1].header and not others, "searching a provider's name lists its models under its header")
	l:Hide()
end
do
	local seq = ns.Transport.stripSeq
	ns.Transport:Apply({ gen = data.gen + 1, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, models = { h = "00000000", g = {} } })
	check(ns.Transport.stripSeq ~= seq and ns.Transport:Payload():find("00000000", 1, true) ~= nil, "a new model list is announced straight away")
	check(ns.Store:ModelOptions("", nil) == nil, "an empty list clears the models")
	check(not hdr.Model:IsShown() and not hdr.Effort:IsShown(), "no models: neither picker is left on screen")
	data.gen = data.gen + 1
	ns.Transport:Apply({ gen = data.gen + 1, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, models = data.models })
	data.gen = data.gen + 1
	check(hdr.Model:IsShown(), "the list comes back")
end
check(ns.Main:ChosenNewModel() == nil and ns.Main:NewThreadModel() ~= nil, "no pick yet: the picker shows T3's default but sends none")
-- Pick the last model that has reasoning levels (any model when none has).
local pick, hasLevels
for _, o in ipairs(Choices(hdr.Model)) do
	if ns.Store:EffortOptions("", o.value) then hasLevels = true end
	if not pick or ns.Store:EffortOptions("", o.value) then pick = o end
end
ns.Main:PickModel(pick.value)
check(ns.db.models[ns.Main.newProject] == pick.value and ns.Main:NewThreadModel() == pick.value, "picked model remembered for the project: " .. pick.label)
local level
if hdr.Effort:IsShown() then
	local levels, default = ns.Store:EffortOptions("", pick.value)
	for _, o in ipairs(levels) do if o.value ~= default then level = o.value end end
	local proj = ns.Store.projectsById[ns.Main.newProject]
	local inherited = (proj.dm == pick.value and proj.de) or ns.Store:LastEffort("", pick.value) or default
	check(ns.Main:ChosenNewEffort() == nil and hdr.Effort.value == inherited, "no level picked: the picker shows the level the thread would get: " .. inherited)
	ns.Main:PickEffort(level)
	check(ns.db.efforts[ns.Main.newProject] == level and hdr.Effort.value == level, "picked level remembered for the project: " .. level)
elseif hasLevels then
	check(false, "the reasoning picker shows for " .. pick.label)
else
	print("skip - no model offers reasoning levels (Orca's agents don't)")
end
local wtSetting
for _, cb in ipairs(ns.Settings.checks or {}) do if cb.key == "newWorktree" then wtSetting = cb end end
if not wtSetting then
	print("skip - no worktree setting (the Orca fork drops it)")
	ns.Main.composer._text = "Build a thing"
	ns.Main:Send()
end
if wtSetting then
	local wt = wtSetting
	check(wt and not wt:GetChecked(), "worktree is a setting, off by default")
	wt:SetChecked(true) -- the stub's Click runs the handler but doesn't flip the box
	wt:Click()
	check(ns.db.settings.newWorktree == true, "ticking the setting remembers worktree threads")
	ns.Main.composer._text = "Build a thing"
	ns.Main:Send()
	local pickI, pickS = ns.Store.SplitModelKey(pick.value)
	check(ns.Transport:Payload():find("Build a thing\031" .. pickI .. "\031" .. pickS .. "\031" .. (level or "") .. "\0311", 1, true) ~= nil, "the worktree setting rides along with the new thread")
	wt:SetChecked(false)
	wt:Click()
	check(ns.db.settings.newWorktree == false, "unticking stops worktree threads")
end
ns.Transport:Apply({ gen = data.gen + 2, results = { { id = ns.Main.pendingNew, ok = true, open = firstThread.id } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(ns.Main.mode == "thread" and ns.viewId == firstThread.id, "result opened the new thread")
check(#ns.Transport.queue == 0, "all commands acknowledged")
check(hdr.Model:IsShown(), "model picker shown for an open thread")
local cur = ns.Main:ThreadModel(ns.Store:Thread(ns.viewId))
local other
for _, o in ipairs(Choices(hdr.Model)) do if o.value ~= cur then other = o break end end
if other then
	ns.Main:PickModel(other.value)
	local oi, os_ = ns.Store.SplitModelKey(other.value)
	check(ns.Transport:Payload():find("\031model\031" .. ns.viewId .. "\031" .. oi .. "\031" .. os_, 1, true) ~= nil, "switching a thread's model sends model")
	check(hdr.Model.value == other.value, "the picker shows the new model straight away")
	ns.Transport:Apply({ gen = data.gen + 3, results = { { id = ns.Main.pendingModel.cmd, ok = false, msg = "Codex is switched off in T3 Code. Pick another model." } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
	check(ns.Main.pendingModel == nil and hdr.Model.value == cur, "a refused switch puts the picker back")
end
do
	local t = ns.Store:Thread(ns.viewId)
	local levels = ns.Store:EffortOptions(ns.Store.EnvOf(t.id), ns.Store.ModelKey(t.mi, t.m))
	check(hdr.Effort:IsShown() == (levels ~= nil), "the reasoning picker shows when the thread's model has levels")
	if levels then
		local next
		for _, o in ipairs(levels) do if o.value ~= hdr.Effort.value then next = o.value break end end
		ns.Main:PickEffort(next)
		check(ns.Transport:Payload():find("\031model\031" .. ns.viewId .. "\031" .. t.mi .. "\031" .. t.m .. "\031" .. next, 1, true) ~= nil, "changing a thread's level sends model with it")
		check(hdr.Effort.value == next, "the picker shows the new level straight away")
		ns.Transport:Apply({ gen = data.gen + 4, results = { { id = ns.Main.pendingEffort.cmd, ok = false, msg = "That level is gone." } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
		check(ns.Main.pendingEffort == nil and hdr.Effort.value ~= next, "a refused level puts the picker back")
	end
end

-- Question / approval rendering
data.gen = data.gen + 10
data.view = data.view or { id = ns.viewId }
data.view.id = ns.viewId
data.view.pending = { id = "req1", kind = "question", questions = { { id = "q1", h = "Mode", q = "Which mode?", opts = { { l = "Fast", d = "quick", v = "fast" }, { l = "Careful", d = "slow", v = "careful" } } } } }
ns.Transport:Apply(data)
local optionRows = 0
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.ed.kind == "option" then optionRows = optionRows + 1 end end
check(optionRows >= 2, "question options rendered: " .. optionRows)
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.kind == "option" and r.ed.label == "Fast" then r.frame:Click() break end
end
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031req1\031q1\031fast", 1, true) ~= nil, "answer command queued")

-- Dictation result from the bridge lands in the message box
ns.Main.composer._text = "Hello"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000, state = "done", text = "run the tests" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "dictated text typed into the box: " .. tostring(ns.Main.composer._text))
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "same dictation not typed twice")
ns.Main.composer._text = "already pasted words"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000 + 5, state = "done", text = "pasted words" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "already pasted words", "text the backend already pasted isn't added again")
ns.Main.composer._text = ""

-- A desktop with no dictation backend (macOS today): the mic says why and sends nothing.
data.bridge.dictation = nil
data.bridge.dictationHint = "Dictation isn't available on macOS yet."
data.gen = data.gen + 1
ns.Transport:Apply(data)
Stub.printed = {}
local queued = #ns.Transport.queue
ns.Main.dictating = false
ns.Main.dictNoteAt = nil
ns.Main:ToggleDictation()
check(not ns.Main.dictating and #ns.Transport.queue == queued, "no dictation backend: nothing is sent")
check(Stub.printed[1] and Stub.printed[1]:find("macOS", 1, true) ~= nil, "the mic explains why: " .. tostring(Stub.printed[1]))
ns.Main:ToggleDictation()
check(#Stub.printed == 1, "a repeated press doesn't repeat the note")
ns.Main:Open()
ns.Main:Refresh()
check(not ns.Main.frame.Bar.Mic:IsEnabled(), "the mic is dimmed while there is no backend")
data.bridge.dictation = "test backend"
data.bridge.dictationHint = nil
data.gen = data.gen + 1
ns.Transport:Apply(data)
ns.Main:Refresh()
check(ns.Main.frame.Bar.Mic:IsEnabled(), "the mic is ready again once a backend is reported")

-- A refused dictate command doesn't leave the mic stuck on.
ns.Main.dictating = false
ns.Main:ToggleDictation()
check(ns.Main.dictating, "dictation starts when a backend is reported")
data.gen = data.gen + 1
ns.Transport:Apply({ gen = data.gen, results = { { id = ns.Main.dictCmd, ok = false, msg = "no microphone" } }, threads = data.threads, projects = data.projects, bridge = data.bridge, usage = data.usage, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(not ns.Main.dictating, "a refused dictate command puts the mic back")

-- Plan, approval details, run summary, queued note
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "plan" end end
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
data.view.plan = "|cffffd100Plan|r\n• step one"
data.view.sum = "Last run: 2 commands · 4m 12s"
data.view.queued = 1
ns.Transport:Apply(data)
local found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text then
		if r.ed.text:find("step one", 1, true) then found.plan = true end
		if r.ed.text:find("Last run", 1, true) then found.sum = true end
		if r.ed.text:find("queued", 1, true) then found.queued = true end
	end
	if r.ed.label == "Read the plan aloud" then found.readPlan = true end
end
check(found.plan and found.readPlan, "plan text shown with a read-aloud option")
check(found.sum and found.queued, "run summary and queued follow-ups shown")
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "input" end end
data.view.plan, data.view.queued = nil, nil
data.view.pending = { id = "ap1", kind = "approval", what = "Change files", detail = "", files = { { f = "a.lua", a = 12, d = 3 } }, always = true }
ns.Transport:Apply(data)
found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text and r.ed.text:find("a.lua", 1, true) and r.ed.text:find("+12", 1, true) then found.files = true end
	if r.ed.label == "Always allow this" then found.always = r end
end
check(found.files, "approval lists the files with +/- counts")
found.always.frame:Click()
check(ns.Transport:Payload():find("approve\031" .. ns.viewId .. "\031ap1\031acceptAlways", 1, true) ~= nil, "Always allow sends acceptAlways")
data.gen = data.gen + 1
data.view.pending = nil
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "waiting" th.run = true th.l = "Build bridge half" end end
ns.Transport:Apply(data)
check(ns.Main.frame.Bar.Stop:IsEnabled(), "a run waiting on its subagent can be stopped")
found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.live then found.live = r.ed.text end
	if r.ed.label == "Carry on" then found.option = true end
end
check(found.live and found.live:find("Build bridge half", 1, true) and not found.option, "the transcript shows what the run waits on, not quick replies")
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.run = nil end end
ns.Transport:Apply(data)
check(not ns.Main.frame.Bar.Stop:IsEnabled(), "waiting between runs has nothing to stop")
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "open" th.l = nil end end
ns.Transport:Apply(data)

-- Notices wait during combat
_G.InCombatLockdown = function() return true end
local t1 = ns.Store.data.threads[2]
ns.Toasts.held = {}
ns:Fire("ThreadTransition", t1, "working", "open")
check(#ns.Toasts.held == 1, "notice held during combat")
_G.InCombatLockdown = function() return false end
ns:Fire("Combat", false)
check(#ns.Toasts.held == 0, "held notice shown after combat")

-- Search and machine filter
ns.ThreadList.query = "zzzz-no-match"
ns.ThreadList:Refresh(true)
local threadRows = 0
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread then threadRows = threadRows + 1 end end
check(threadRows == 0, "search hides non-matching threads")
ns.ThreadList.query = nil
local groups = ns.Store:Groups("m:local")
check(#groups.working + #groups.open + #groups.settled > 0, "machine filter (this computer) keeps local threads")
groups = ns.Store:Groups("m:foundry")
check(#groups.working + #groups.open + #groups.settled == 0, "machine filter (foundry) excludes local threads")
ns.ThreadList:Refresh(true)

-- Report: diagnostics in the box + a screenshot request
ns.Main.composer._text = ""
ns.Main:Report("the list flickers")
check(ns.Main.composer._text:find("the list flickers", 1, true) and ns.Main.composer._text:find("diagnostics", 1, true), "report fills the message box")
check(ns.Transport:Payload():find("\031shot\031", 1, true) ~= nil, "report asks the bridge for a screenshot")
ns.Main.composer._text = ""

-- Suggestions above the message box: "/" lists the provider's slash commands, "$" its
-- skills. The checks bring their own list, so they don't depend on the snapshot's.
do
	local S, main = ns.Suggest, ns.Main
	local box = main.composer
	local eb = box:GetEditBox()
	for _, g in ipairs(data.models and data.models.g or {}) do
		for _, p in ipairs(g.p or {}) do
			if p.c then check(ns.Store:Commands(g.e or "", p.i) == p.c, "the snapshot's commands and skills are kept for " .. p.i .. ": " .. #p.c) end
		end
	end
	local env, instanceId = main:NextProvider()
	check(instanceId ~= nil, "the open thread's provider is known: " .. tostring(instanceId))
	local saved = ns.Store.commands
	local list = {
		{ t = "/pr-comments", d = "Get comments from a pull request" },
		{ t = "/compact", d = "Summarize the conversation" },
		{ t = "/review" },
		{ t = "/status", d = "Show || status" },
		{ t = "$deploy", d = "Ship it" },
		{ t = "$code-review", d = "Review the code" },
	}
	ns.Store.commands = { [env] = { [instanceId] = list } }
	local function typed(text, cursor)
		box._text, eb._cursor, box._focus = text, cursor, true
		Stub.Callback(box, "OnTextChanged", eb, true)
	end
	local function names()
		local out = {}
		for _, e in ipairs(S.state and S.state.matches or {}) do table.insert(out, e.t) end
		return table.concat(out, " ")
	end
	local queued = #ns.Transport.queue

	typed("/")
	check(S.state and S.frame:IsShown() and names() == "/pr-comments /compact /review /status", "a bare / lists every slash command: " .. names())
	local p = S.frame._points[1]
	check(p[1] == "BOTTOMLEFT" and p[2] == main.frame.Pages.threads.Right.ComposerInset and p[3] == "TOPLEFT", "the list sits on top of the message box")
	typed("$")
	check(names() == "$deploy $code-review", "$ lists the skills: " .. names())
	typed("/CO")
	check(names() == "/compact /pr-comments", "typing filters it, names that start with the text first: " .. names())
	typed("/zzz")
	check(S.state == nil and not S.frame:IsShown(), "nothing matches: no list")
	typed("path/to/file")
	check(S.state == nil, "a / inside a word is not a command")

	typed("/co")
	eb._scripts.OnKeyDown(eb, "DOWN")
	check(S.state.index == 2 and eb:GetCursorPosition() == 3, "Down moves the highlight and leaves the cursor where it was")
	eb._scripts.OnTabPressed(eb)
	check(box._text == "/pr-comments " and eb:GetCursorPosition() == #box._text and S.state == nil, "Tab puts the highlighted one in, with a space: " .. box._text)

	typed("fix this /re now", 12)
	check(names() == "/review", "a token mid-message is suggested too: " .. names())
	eb._scripts.OnTabPressed(eb)
	check(box._text == "fix this /review now" and eb:GetCursorPosition() == 17, "it replaces the token without doubling the space after it: " .. box._text)

	typed("/comp")
	Stub.Callback(box, "OnEnterPressed", eb)
	check(box._text == "/compact " and #ns.Transport.queue == queued and S.state == nil, "Enter with the list open puts the command in and sends nothing")
	local shift = IsShiftKeyDown
	_G.IsShiftKeyDown = function() return true end
	typed("/comp")
	Stub.Callback(box, "OnEnterPressed", eb)
	_G.IsShiftKeyDown = shift
	check(box._text == "/comp\n" and #ns.Transport.queue == queued, "Shift+Enter still starts a new line")

	local long = {}
	for i = 1, 20 do long[i] = { t = string.format("/cmd%02d", i) } end
	ns.Store.commands = { [env] = { [instanceId] = long } }
	typed("/")
	for _ = 1, 9 do eb._scripts.OnKeyDown(eb, "DOWN") end
	check(S.state.index == 10 and S.state.offset == 3 and S.frame.Rows[8].index == 10, "Down past the last row scrolls the list")
	S.frame._scripts.OnMouseWheel(S.frame, -1)
	check(S.state.offset == 6 and S.state.index == 10, "the wheel scrolls it")
	S.frame._scripts.OnMouseWheel(S.frame, 1)
	S.frame._scripts.OnMouseWheel(S.frame, 1)
	check(S.state.offset == 1 and S.state.index == 8, "and keeps the highlight among the rows on screen")
	ns.Store.commands = { [env] = { [instanceId] = list } }

	typed("/st")
	S.frame.Rows[1]:Click()
	check(box._text == "/status " and box._focus and S.state == nil, "a click picks it and keeps the message box focused")

	typed("/")
	Stub.Callback(box, "OnEscapePressed", eb)
	check(S.state == nil and not S.frame:IsShown() and box._focus, "Esc closes the list and keeps the message box")
	Stub.Callback(box, "OnEscapePressed", eb)
	check(not box._focus, "Esc again leaves the message box")

	typed("/compact please")
	check(S.state == nil, "past the token the list is closed")
	Stub.Callback(box, "OnEnterPressed", eb)
	check(#ns.Transport.queue == queued + 1 and ns.Transport:Payload():find("/compact please", 1, true) ~= nil, "Enter with the list closed sends the message as typed")
	table.remove(ns.Transport.queue)
	ns.Transcript.echo[ns.viewId] = nil

	box._focus, box._text = false, "/"
	Stub.Callback(box, "OnTextChanged", eb, true)
	check(S.state == nil, "no list while the message box isn't focused")
	typed("/")
	Stub.Callback(box, "OnTextChanged", eb, false)
	check(S.state == nil, "text the addon puts in the box closes the list")
	typed("/")
	main.frame:Hide()
	check(S.state == nil, "closing the window closes the list")
	main:Open()
	typed("/")
	main:StartNewThread()
	check(S.state == nil, "starting a new thread closes the list")
	main:Back()

	local insert = main.frame.Bar.Insert
	main:Refresh()
	check(insert:IsEnabled(), "the insert button is on when the provider has a list")
	box._text, eb._cursor = "run", nil
	insert:Click()
	local l = ns.UI.ListOpen()
	check(l and l.owner == insert and l._points[1][1] == "BOTTOMLEFT" and l._points[1][3] == "TOPLEFT", "it opens the shared list above itself")
	local headers, row = {}, nil
	for _, r in ipairs(l.Box._rows) do
		if r.ed.header then table.insert(headers, r.ed.label) end
		if r.ed.value == "$deploy" then row = r.frame end
	end
	check(table.concat(headers, ",") == "Commands,Skills", "commands and skills under their own headers: " .. table.concat(headers, ","))
	row:Click()
	check(ns.UI.ListOpen() == nil and box._text == "run $deploy " and box._focus, "a pick goes in at the cursor, after a space: " .. box._text)

	ns.Store.commands = {}
	main:Refresh()
	check(not insert:IsEnabled(), "the insert button is off when the provider has no list")
	typed("/")
	check(S.state == nil, "and typing / suggests nothing")

	ns.Store.commands = saved
	box:SetText("")
	box._focus = false
	ns.db.drafts[ns.viewId] = nil
	ns.db.drafts.__new = nil
	main:Refresh()
end

-- Attending flag: set while the window is in use, cleared after 90s idle
ns.Main:Open()
ns.Interacted()
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) ~= nil, "attending while using the window")
Stub.now = Stub.now + 100
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) == nil, "not attending after 90s idle")

-- Self-test runs
ns.SelfTest()
check(true, "self-test ran")

-- Window size
ns.db.settings.windowScale = "xlarge"
ns.Main:ApplyScale()
check(true, "window scale applied")
ns.db.settings.windowScale = "auto"

-- Transitions -> toast
local t = ns.Store.data.threads[1]
local before = t.s
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "working" end end
ns.Transport:Apply(data)
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "open" th.un = true end end
ns.Transport:Apply(data)
local toastShown = ns.Toasts.frames[1] and ns.Toasts.frames[1]._shown
check(toastShown or (ns.windowOpen and ns.viewId == t.id), "finish transition produced a toast")

-- Tracker and tickers run
ns.Tracker:Refresh()
for _ = 1, 5 do Stub.Tick(1) end
check(true, "tickers ran")

-- Gamepad mode: the window captures the controller itself.
Stub.gamepad = true
ns.Main.frame:Hide()
ns.Main:Open()
local f = ns.Main.frame
check(ns.Gamepad.capturing, "window captures the controller in gamepad mode")
local down = f._scripts.OnGamePadButtonDown
check(down ~= nil and f._scripts.OnGamePadStick ~= nil, "button and stick handlers installed")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected ~= nil, "cursor starts on a control")
check(down(f, "PADDDOWN") == false, "D-pad consumed (character doesn't move)")
check(f._scripts.OnGamePadStick(f, "Left", 0, -1) == false, "left stick consumed")
check(down(f, "PADFORWARD") == false and f._shown == false and not ns.Gamepad.capturing, "Start closes the window and gives the controller back")
ns.Main:Open()
check(ns.Gamepad.capturing, "reopened window takes the controller again")
-- Commands and skills from the controller: the bar's insert button, then a row.
do
	local saved = ns.Store.commands
	local env, instanceId = ns.Main:NextProvider()
	ns.Store.commands = { [env] = { [instanceId] = { { t = "/compact" }, { t = "$deploy" } } } }
	ns.Main:Refresh()
	local insert, reachable = f.Bar.Insert, false
	for _, c in ipairs(ns.Gamepad:Candidates()) do if c.w == insert then reachable = true end end
	check(reachable, "the controller can reach the insert button")
	ns.Main.composer:SetText("")
	ns.Gamepad:Highlight(insert)
	down(f, "PAD1")
	check(ns.UI.ListOpen() and ns.UI.ListOpen().owner == insert, "A on it opens the list")
	down(f, "PAD1")
	check(ns.Main.composer._text == "/compact " and ns.Gamepad.selected == ns.Main.composer, "A on a row puts it in and lands on the message box")
	ns.Store.commands = saved
	ns.Main.composer:SetText("")
	ns.Main.composer._focus = false
	ns.Main:Refresh()
end
-- The model picker sits on the header row: D-pad to it, A opens its list, B closes it.
do
	local prevView = ns.viewId
	ns.Main:StartNewThread()
	ns.Gamepad:Highlight(hdr.Project)
	down(f, "PADDRIGHT")
	check(ns.Gamepad.selected == hdr.Model, "Right from the project goes to the model picker")
	down(f, "PAD1")
	local l = ns.UI.ListOpen()
	check(l ~= nil and l.owner == hdr.Model, "A opens the model list")
	local rows, onHeader = 0, false
	for _, c in ipairs(ns.Gamepad:Candidates()) do
		rows = rows + 1
		if c.ed and c.ed.header then onHeader = true end
	end
	check(rows > 0 and not onHeader, "the D-pad skips group headers in the list: " .. rows .. " rows")
	down(f, "PAD2")
	check(ns.UI.ListOpen() == nil and f._shown, "B closes the model list, not the window")
	if hdr.Effort:IsShown() then
		down(f, "PADDRIGHT")
		check(ns.Gamepad.selected == hdr.Effort, "Right from the model goes to the reasoning picker")
		down(f, "PAD1")
		local open = ns.UI.ListOpen()
		check(open ~= nil and open.owner == hdr.Effort, "A opens the reasoning list")
		down(f, "PAD2")
		down(f, "PADDLEFT")
		check(ns.Gamepad.selected == hdr.Model, "Left from the reasoning picker goes back to the model")
	end
	down(f, "PADDLEFT")
	check(ns.Gamepad.selected == hdr.Project, "Left goes back to the project")
	ns.Main:SelectThread(prevView)
end
check(down(f, "PADRSHOULDER") == false and ns.Main.page == "usage", "RB switched to usage")
down(f, "PADLSHOULDER")
check(ns.Main.page == "threads", "LB switched back")
down(f, "PAD4")
check(ns.Main.dictating, "Y starts dictation")
f._scripts.OnGamePadButtonUp(f, "PAD4")
check(not ns.Main.dictating, "Y release stops dictation")
-- A on a thread row opens it
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do
	if r.ed.thread then ns.Gamepad:Highlight(r.frame) break end
end
ns.viewId = nil
down(f, "PAD1")
check(ns.viewId ~= nil, "A opened the highlighted thread")
-- D-pad routes between the list, the conversation and the message box
local function rowFor(id)
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread and r.ed.thread.id == id then return r.frame end end
end
data.gen = data.gen + 1
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
ns.Transport:Apply(data)
ns.Gamepad:Highlight(rowFor(ns.viewId) or ns.ThreadList.scrollBox._rows[2].frame)
down(f, "PADDRIGHT")
check(ns.Gamepad.selected == ns.Main.composer, "Right from the list goes to the message box")
down(f, "PADDDOWN")
check(ns.Gamepad.selected == f.Bar.Send, "Down from the message box goes to Send")
down(f, "PADDUP")
check(ns.Gamepad.selected == ns.Main.composer, "Up from Send goes back to the message box")
down(f, "PADDLEFT")
local sel = ns.Gamepad.selected
local onRow = false
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.frame == sel and r.ed.thread and r.ed.thread.id == ns.viewId then onRow = true end end
check(onRow, "Left from the conversation returns to the open thread's row")
data.gen = data.gen + 1
data.view.pending = { id = "req2", kind = "question", questions = { { id = "q", h = "Pick", q = "Which?", opts = { { l = "One", d = "", v = "1" }, { l = "Two", d = "", v = "2" } } } } }
ns.Transport:Apply(data)
down(f, "PADDRIGHT")
local selEd
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.kind == "option" and selEd.label == "One", "Right goes straight to the first answer when the agent is asking")
down(f, "PADDDOWN")
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.label == "Two", "Down steps to the next answer")
data.gen = data.gen + 1
data.view.pending = nil
ns.Transport:Apply(data)
-- A on the project dropdown opens a real list; the cursor moves inside it
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
local listFrame = ns.UI.ListOpen()
check(listFrame ~= nil, "A opens the project list")
local rows = listFrame.Box._rows or {}
check(#rows >= 2, "list shows the projects: " .. #rows)
local cands = ns.Gamepad:Candidates()
check(#cands == #rows, "cursor is confined to the list rows")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected and ns.Gamepad.selected == rows[1].frame, "cursor starts on the current choice (All projects)")
ns.Gamepad:Highlight(rows[2].frame)
down(f, "PAD1")
check(ns.UI.ListOpen() == nil, "picking closes the list")
check(ns.db.settings.project == rows[2].ed.value, "picked project applied: " .. ns.db.settings.project)
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
down(f, "PAD2")
check(ns.UI.ListOpen() == nil and f._shown, "B closes the list, not the window")
ns.db.settings.project = "all"
-- Mouse: click opens, clicking a row picks
ns.ThreadList.dropdown._scripts.OnClick(ns.ThreadList.dropdown, "LeftButton")
check(ns.UI.ListOpen() ~= nil, "click opens the list")
ns.UI.ListOpen().Box._rows[2].frame:Click()
check(ns.db.settings.project ~= "all", "click on a row picks it")
ns.db.settings.project = "all"
-- B leaves the composer, then closes
ns.Main.composer._focus = true
down(f, "PAD2")
check(not ns.Main.composer._focus, "B leaves the message box")
down(f, "PAD2")
check(not f._shown, "B closes the window")
check(not ns.Gamepad.capturing, "controller released on close")

-- The open thread's family is a snapshot part of its own, like the transcript: kept
-- while `same` names it, recorded only when it was sent, and reported in the hello.
do
	local Store = ns.Store
	local savedView, savedFam = ns.viewId, data.fam
	ns.viewId = data.threads[1].id
	local fam = { id = ns.viewId, kids = { { id = "kid-1", t = "A child", s = "working", k = "sub" } } }
	local function apply(part)
		data.gen = data.gen + 1
		part.gen, part.threads, part.bridge, part.usage = data.gen, data.threads, data.bridge, data.usage
		part.ack = { ui = ns.ui, seq = ns.Transport.stripSeq }
		ns.Transport:Apply(part)
	end
	apply({ x = { l = "L1", p = "P1", v = "V1", f = "F1" }, projects = data.projects, view = data.view, fam = fam })
	check(Store.familyKey == "F1" and Store:Family() == fam, "the addon records the family it was sent")
	apply({ same = "pvf", x = { l = "L2", p = "P2", v = "V2", f = "F2" } })
	check(Store:Family() == fam and Store.familyKey == "F1", "an omitted family is kept, under the hash it came with")
	local tail = "\031V1\031F1"
	check(ns.Transport:Hello():sub(-#tail) == tail, "the hello ends with the family's hash, after the transcript's")
	apply({ same = "pv", x = { l = "L3", p = "P1", v = "V1", f = "" } })
	check(Store.data.fam == nil and Store.familyKey == "", "a family neither sent nor kept is gone, and its hash isn't claimed")
	ns.viewId, data.fam = savedView, savedFam
	data.gen = data.gen + 1
	ns.Transport:Apply(data)
end

-- A command the addon accepts must still fit beside the hello after the player opens a
-- subagent, whose id is about 125 characters, or it would never go.
do
	local T, Store = ns.Transport, ns.Store
	local savedView, savedQueue = ns.viewId, T.queue
	T.queue = {}
	local saved = { Store.listKey, Store.projectsKey, Store.viewKey, Store.familyKey }
	local hash = string.rep("a", 16)
	local project = Store.data.projects[1].id
	ns.viewId = nil
	Store.listKey, Store.projectsKey, Store.viewKey, Store.familyKey = hash, hash, "", ""
	local function accepted(n)
		local before = #T.queue
		T:Send("new", project, string.rep("x", n))
		if #T.queue == before then return false end
		table.remove(T.queue)
		return true
	end
	local lo, hi = 0, 3000
	while hi - lo > 1 do
		local mid = math.floor((lo + hi) / 2)
		if accepted(mid) then lo = mid else hi = mid end
	end
	check(lo >= 2000, "a new thread of 2,000 characters still goes: up to " .. lo)
	T:Send("new", project, string.rep("x", lo))
	ns.viewId = "e1~thread:delegated-task:" .. string.rep("s", 105)
	Store.viewKey, Store.familyKey = hash, hash
	check(T:Payload():find(string.rep("x", lo), 1, true) ~= nil, "the longest one accepted still fits once a subagent is open")
	-- A Claude subagent's id is longer still (about 210 characters): a command that no
	-- longer fits is dropped with a notice, so the commands behind it still go.
	ns.viewId = "e1~thread:delegated-task:" .. string.rep("s", 185)
	T:Send("read", "after-it")
	local payload = T:Payload()
	check(payload:find(string.rep("x", lo), 1, true) == nil and payload:find("after-it", 1, true) ~= nil and #T.queue == 1,
		"a command outgrown by a long thread id is dropped, and the queue behind it goes on")
	table.remove(T.queue)
	ns.viewId = "00000000-0000-0000-0000-000000000000"
	T:Send("send", ns.viewId, string.rep("x", 2000), "steer")
	check(#T.queue == 1, "a 2,000-character message to an open thread still goes")
	ns.viewId, T.queue = savedView, savedQueue
	Store.listKey, Store.projectsKey, Store.viewKey, Store.familyKey = saved[1], saved[2], saved[3], saved[4]
end

-- A subagent its provider started takes no messages (T3 Code refuses them): the window
-- says so and sends nothing.
do
	local savedFam, savedMode, wasShown = ns.Store.data.fam, ns.Main.mode, ns.Main.frame:IsShown()
	ns.Main.frame:Show()
	ns.Main.mode = "thread"
	ns.Store.data.fam = { id = ns.viewId, ro = true, up = { t = "Lead", k = "sub" } }
	ns.Main:Refresh()
	check(not ns.Main.frame.Bar.Send:IsEnabled(), "Send is off for a read-only subagent")
	local queued = #ns.Transport.queue
	ns.Main:Send("hello?")
	check(#ns.Transport.queue == queued, "and nothing is sent to it")
	ns.Store.data.fam, ns.Main.mode = savedFam, savedMode
	ns.Main:Refresh()
	check(ns.Main.frame.Bar.Send:IsEnabled(), "Send comes back for an ordinary thread")
	if not wasShown then ns.Main.frame:Hide() end
end

-- The family bar: the thread the open one came from, and the threads it started.
local FAMILY_PARENT = "thread:project:" .. string.rep("p", 36)
local function KidId(n) return "thread:delegated-task:" .. string.rep("c", 96) .. string.format("-%03d", n) end
local familyKids = {}
for n = 1, 31 do
	familyKids[n] = { id = KidId(n), t = "Child " .. n, s = n == 1 and "input" or (n <= 3 and "working" or "settled"), k = "sub", env = n == 4 and "laptop" or nil }
end
local function ParentFamily()
	local project = ns.Store.data.projects[1].id
	return { id = FAMILY_PARENT, me = { id = FAMILY_PARENT, title = "Refactor the slot writer", p = project, s = "working", l = "Working", st = time() - 600 }, kids = familyKids }
end
local function ChildFamily(n, up, kids)
	local project = ns.Store.data.projects[1].id
	return {
		id = KidId(n),
		me = { id = KidId(n), title = "Child " .. n, p = project, s = familyKids[n].s, l = "Settled", u = time() - 60 },
		up = up or { id = FAMILY_PARENT, t = "Refactor the slot writer", s = "working", k = "sub" },
		kids = kids,
	}
end
local function ShowFamily(fam)
	data.fam = fam
	data.view = { id = fam.id, msgs = {} }
	data.gen = data.gen + 1
	ns.Transport:Apply(data)
end
local savedFamily = { view = ns.viewId, fam = data.fam, data = data.view }
local bar = ns.Family.bar
local plain = ns.StripMarkup

do
	ns.Main:Open()
	ns.Main:SelectThread(FAMILY_PARENT)
	check(not f.Subtitle:GetText():find("No thread selected", 1, true), "a thread that isn't loaded yet is never shown as no thread selected")
	ShowFamily(ParentFamily())
	check(f.Subtitle:GetText() == "Refactor the slot writer" and hdr.Action:IsShown(), "a thread left out of the list gets its full header from the row sent with its family")
	check(bar:IsShown() and bar.Kids:IsShown() and not bar.Up:IsShown(), "a thread with children shows the Kids button, and no Up link without a parent")
	local insetTop
	for _, pt in ipairs(ns.Transcript.inset._points) do if pt[1] == "TOPLEFT" then insetTop = pt[2] end end
	check(insetTop == bar, "the conversation hangs under the bar")
	check(plain(bar.Kids:GetText()) == "Subagents (31) · 1 needs you", "Kids counts the children and how many need you: " .. plain(bar.Kids:GetText()))

	bar.Kids:Click()
	local l = ns.UI.ListOpen()
	check(l and l.owner == bar.Kids and #l.Box._rows == 31 and l.Search:IsShown(), "Kids opens the shared list with every child, and its search box")
	check(plain(l.Box._rows[1].ed.label) == "Needs you  Child 1" and plain(l.Box._rows[4].ed.label) == "Settled  Child 4  · laptop", "each row reads status first, then title, then another machine")
	l.Box._rows[5].frame:Click()
	check(ns.viewId == KidId(5) and not l:IsShown(), "clicking a child in the list opens it")
	check(f.Subtitle:GetText() == "Child 5" and hdr.Text:GetText():find("Loading…", 1, true) and not hdr.Action:IsShown(), "until its snapshot comes, the header shows the child from the family held, loading")
	check(not bar:IsShown(), "the bar waits for the child's own family")
	for _, pt in ipairs(ns.Transcript.inset._points) do if pt[1] == "TOPLEFT" then insetTop = pt[2] end end
	check(insetTop == hdr, "without the bar, the conversation hangs under the header")

	ShowFamily(ChildFamily(5))
	check(bar.Up:IsShown() and bar.Up:IsEnabled() and not bar.Kids:IsShown(), "a subagent's bar links to its parent")
	check(plain(bar.Up.Text:GetText()) == "Started by: Refactor the slot writer" and plain(bar.Up.Status:GetText()) == "Working", "Up names the parent and its status")
	check(f.Subtitle:GetText() == "Child 5" and hdr.Text:GetText():find("Settled", 1, true), "the child's header fills in from its own row")
	check(not hdr.Action:IsShown() and not hdr.Snooze:IsShown() and not hdr.Archive:IsShown() and not hdr.Model:IsShown() and not hdr.Effort:IsShown(), "a subagent's header has no Settle, Snooze or model picker: the thread that started it runs it")
	bar.Up:Click()
	check(ns.viewId == FAMILY_PARENT and f.Subtitle:GetText() == "Refactor the slot writer", "Up opens the parent, its title shown at once from the family held")
	check(plain(hdr.Text:GetText()) == "Working  ·  Loading…", "with its status, loading: " .. plain(hdr.Text:GetText()))

	for _, case in ipairs({
		{ up = { id = FAMILY_PARENT, t = "Base", s = "open", k = "fork" }, text = "Forked from: Base" },
		{ up = { id = FAMILY_PARENT, t = "Base", s = "open", k = "side" }, text = "Side chat of: Base" },
		{ up = { id = "e1~sender", t = "Base", s = "open", k = "sent", env = "laptop" }, text = "Sent from laptop: Base" },
		{ up = { t = "Base", k = "sent" }, text = "Sent from another computer: Base", off = true },
	}) do
		ns.Main:SelectThread(KidId(6))
		ShowFamily(ChildFamily(6, case.up))
		check(plain(bar.Up.Text:GetText()) == case.text and bar.Up:IsEnabled() == not case.off, "Up reads " .. case.text .. (case.off and ", and can't be opened" or ""))
	end

	local function label(kinds, statuses)
		local kids = {}
		for n, k in ipairs(kinds) do kids[n] = { k = k, s = statuses[n] } end
		return plain(ns.Family.KidsLabel(kids))
	end
	check(label({ "fork", "fork" }, { "open", "settled" }) == "Forks (2)", "Kids names forks")
	check(label({ "side" }, { "working" }) == "Side chats (1) · 1 working", "Kids names side chats, with how many are working")
	check(label({ "sent", "sent" }, { "input", "plan" }) == "Sent to other computers (2) · 2 need you", "Kids names threads sent away, with how many need you")
	check(label({ "sub", "fork", "sent" }, { "waiting", "working", "open" }) == "Started here (3) · 2 working", "mixed children are threads started here")
end

-- Controller: the bar is a row of its own in the conversation column.
do
	local G = ns.Gamepad
	check(G.capturing, "the controller drives the window")
	local grandkids = { { id = "thread:grandchild", t = "Grandchild", s = "open", k = "sub" } }
	ns.Main:SelectThread(KidId(7))
	ShowFamily(ChildFamily(7, { id = FAMILY_PARENT, t = "Refactor the slot writer", s = "working", k = "fork" }, grandkids))
	check(hdr.Action:IsShown(), "a fork keeps its own Settle")
	G:Highlight(hdr.Action)
	down(f, "PADDDOWN")
	check(G.selected == bar.Up, "Down from Settle goes to Up")
	down(f, "PADDRIGHT")
	check(G.selected == bar.Kids, "Right from Up goes to Kids")
	down(f, "PADDLEFT")
	check(G.selected == bar.Up, "Left from Kids goes back to Up")
	down(f, "PADDLEFT")
	local inList = false
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.frame == G.selected and r.ed.thread then inList = true end end
	check(inList, "Left past Up goes to the thread list")
	G:Highlight(bar.Up)
	down(f, "PADDUP")
	check(G.selected == hdr.Action, "Up from the bar goes back to Settle")
	G:Highlight(ns.Main.composer)
	down(f, "PADDUP")
	check(G.selected == bar.Up, "Up from the message box goes to the bar")

	down(f, "PAD1")
	check(ns.viewId == FAMILY_PARENT and G.selected == ns.Main.composer, "A on Up opens the parent; the cursor waits on the message box")
	ShowFamily(ParentFamily())
	check(G.selected == bar.Kids, "once the parent's bar shows, the cursor is on Kids, the way back")

	down(f, "PAD1")
	local l = ns.UI.ListOpen()
	check(l and l.owner == bar.Kids, "A on Kids opens the list")
	local function onRow()
		for _, r in ipairs(l.Box._rows) do if r.frame == G.selected then return r.ed.value end end
	end
	check(onRow() == KidId(1), "the cursor starts on the first child")
	for _ = 1, 40 do down(f, "PADDDOWN") end
	check(onRow() == KidId(31), "Down walks the list by its order to the last of 31 children")
	down(f, "PADDUP")
	check(onRow() == KidId(30), "and Up steps back")
	down(f, "PADDDOWN")
	-- In game the list's close is handled a frame later; run the timers in that order.
	local queued, after = {}, C_Timer.After
	C_Timer.After = function(_, fn) table.insert(queued, fn) end
	down(f, "PAD1")
	C_Timer.After = after
	for _, fn in ipairs(queued) do fn() end
	check(ns.viewId == KidId(31) and G.selected == ns.Main.composer, "A opens that child, and the list closing doesn't pull the cursor off the message box")
	ShowFamily(ChildFamily(31))
	check(G.selected == bar.Up, "once the child's bar shows, the cursor is on Up, the way back")
	down(f, "PADDUP")
	check(G.selected == bar.Up, "on a subagent the bar is the top of the column")

	down(f, "PAD1")
	down(f, "PADDDOWN")
	ShowFamily(ParentFamily())
	check(ns.viewId == FAMILY_PARENT and G.selected == f.Bar.Send, "a cursor the player moved while it loaded stays where they put it")

	ns.Main:SelectThread(KidId(8))
	ShowFamily(ChildFamily(8, { t = "Elsewhere", k = "sent" }))
	local candidate = false
	for _, c in ipairs(G:Candidates()) do if c.w == bar.Up then candidate = true end end
	check(bar.Up:IsShown() and not candidate, "a link to a computer the bridge doesn't know is shown, but the cursor can't land on it")
	G:Highlight(hdr.Action)
	down(f, "PADDDOWN")
	check(G.selected == ns.Main.composer, "Down from Settle passes it by")
end

ns.Main:SelectThread(savedFamily.view)
data.fam, data.view = savedFamily.fam, savedFamily.data
data.gen = data.gen + 1
ns.Transport:Apply(data)
f:Hide()

-- Launching without a keyboard
check(ns.Launcher.chord == "PADLTRIGGER-PADRTRIGGER-PADBACK", "controller shortcut: both triggers + Back")
check(next(Stub.overrides) == nil, "no key bindings overridden (Forever's controller mode ignores them)")
GameMenuFrame:InitButtons()
local entry
for _, b in ipairs(GameMenuFrame.buttons) do if b.text == "Orca" then entry = b end end
check(entry and entry.layoutIndex == 4.5, "game menu entry sits above Log Out")
_G.HideUIPanel = function() end
entry.cb()
check(f._shown, "game menu entry opens the window")
Orca_Binding("toggle")
check(not f._shown, "shortcut toggles it closed")
check(#(ns.db.errors or {}) == 0, "no errors recorded")

-- Slash command
SlashCmdList.ORCA("status")
check(#Stub.printed > 0, "status printed: " .. Stub.printed[#Stub.printed])

-- Self-test: the long control plays, the empty one doesn't -> bells usable
Stub.validSounds = { ["Interface\\AddOns\\Orca\\Signals\\03999.wav"] = true }
ns.Transport.signals = "untested"
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "ok", "self-test passes when the long control plays: " .. ns.Transport.signals)
Stub.validSounds = {}
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "muted", "self-test fails when nothing really plays (Forever says willPlay=true anyway)")
ns.Transport.signals = "ok"

-- A bell rung a couple of numbers ahead is still heard; bells map onto 8 rotating
-- files. Only a fresh snapshot moves the bell position (to the bridge's nextSig).
local function BellPath(k) return string.format("Interface\\AddOns\\Orca\\Signals\\%05d.wav", 3991 + (k - 1) % 8) end
local freshFile = os.tmpname()
do
	local fh = assert(io.open(freshFile, "w"))
	fh:write(string.format("dofile(%q) Orca_Inbox.gen = 9e15 Orca_Inbox.nextSig = 503\n", snapshot))
	fh:close()
end
ns.Transport.exhausted = nil
ns.Transport.bellProbe = nil
ns.Transport.ringCooldownUntil = nil
ns.db.sigNext = 500
Stub.slotData[ns.Transport.slotCursor] = freshFile
Stub.validSounds = { [BellPath(502)] = true }
local loadsBefore = Stub.loadCount or 0
Stub.Tick(0.6) -- starts listening
Stub.Tick(0.2) -- checks which bell is really playing
check((Stub.loadCount or 0) > loadsBefore, "loaded a slot when bell 502 rang")
check(ns.db.sigNext == 503, "took the bridge's next bell from the fresh snapshot: " .. ns.db.sigNext)

-- A bell that leads to old data is a false alarm: no moving ahead (which would
-- alias still-rung bells and run away), a short cooldown, and a fresh strip.
Stub.validSounds = { [BellPath(504)] = true }
local loads1 = Stub.loadCount
ns.Transport.bellProbe = nil
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1 and ns.db.sigNext == 503, "false ring: one slot loaded, position kept at " .. ns.db.sigNext)
check(ns.Transport.falseRings == 1 and ns.Transport.stripShown, "false ring counted and the strip redrawn")
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1, "cooldown: no slot burned by the same false alarm")

-- A laggy client: even the empty control still "plays" at check time. Wait it out
-- instead of trusting the bells.
Stub.now = Stub.now + 5
ns.Transport:HideStrip() -- (as if the bridge acknowledged it; isolates the bell check)
ns.Transport.lastLoadAt = Stub.now
ns.Transport.bellProbe = nil
Stub.validSounds = { [BellPath(503)] = true, ["Interface\\AddOns\\Orca\\Signals\\04000.wav"] = true }
local loads2 = Stub.loadCount
for _ = 1, 12 do Stub.Tick(0.2) end
check(Stub.loadCount == loads2, "no slot loaded while the client is too slow to tell bells apart")
Stub.validSounds = {}
ns.Transport.bellProbe = nil
local loads3 = Stub.loadCount
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads3, "no slot spent while no bell rings")
os.remove(freshFile)

-- Controller shortcut: hold both triggers, press Back. Read from the controller's
-- state only: the watcher must never take gamepad input (that breaks LT + RT action bars).
do
	local L = ns.Launcher
	L:SetupChord()
	check(L.chordText and L.chordText:find("Left trigger", 1, true) and L.chordText:find("Gamepad_Ltr_View", 1, true), "shortcut shown as the player's buttons: " .. tostring(L.chordText))
	check(not L.chordText:find("RT", 1, true), "no hard-coded Xbox names")
	local w = L.watcher
	check(w._scripts.OnGamePadButtonDown == nil and not w._gamepadEnabled, "the watcher never takes controller input")
	local function frame() Stub.now = Stub.now + 0.06 w._scripts.OnUpdate(w, 0.06) end
	local wasOpen = ns.windowOpen
	WOWSTUB.padHeld = { PADLTRIGGER = true, PADRTRIGGER = true }
	frame()
	check(ns.windowOpen == wasOpen, "holding the triggers alone does nothing (LT + RT action bars stay the game's)")
	WOWSTUB.padHeld.PADBACK = true
	frame()
	check(ns.windowOpen ~= wasOpen, "triggers + Back toggles T3 Code")
	frame()
	frame()
	check(ns.windowOpen ~= wasOpen, "holding Back doesn't toggle it again")
	WOWSTUB.padHeld = { PADBACK = true }
	if ns.windowOpen ~= wasOpen then ns.Launcher:Open() end
	frame()
	WOWSTUB.padHeld = {}
	frame()
	WOWSTUB.padHeld = { PADBACK = true }
	frame()
	check(ns.windowOpen == wasOpen, "Back on its own is left to the game")
	WOWSTUB.padHeld = {}
	frame()

	-- Back a moment before the triggers: with a 20 Hz read the two can land on
	-- different frames, and the chord must still fire.
	WOWSTUB.padHeld = { PADBACK = true }
	frame()
	WOWSTUB.padHeld = { PADBACK = true, PADLTRIGGER = true, PADRTRIGGER = true }
	frame()
	check(ns.windowOpen ~= wasOpen, "Back a moment before the triggers still opens it")
	frame()
	frame()
	check(ns.windowOpen ~= wasOpen, "and holding all three doesn't toggle it again")
	if ns.windowOpen ~= wasOpen then ns.Launcher:Open() end
	WOWSTUB.padHeld = {}
	frame()
end

-- Tracker section follows the objective tracker, in the quest column.
do
	local f = ns.Tracker.frame
	local function anchoredTo(target)
		for _, pt in ipairs(f._points or {}) do if pt[2] == target then return true end end
		return false
	end
	WOWSTUB.Tick(0.3)
	check(ns.Tracker.attached == "below" and anchoredTo(ObjectiveTrackerFrame.NineSlice), "tracker section sits under the quests: " .. tostring(ns.Tracker.attached))
	check(f:GetWidth() == 280, "same width as the objective tracker")
	ObjectiveTrackerFrame.isCollapsed = true
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "header" and anchoredTo(ObjectiveTrackerFrame.Header), "under the header when All Objectives is collapsed")
	ObjectiveTrackerFrame.isCollapsed = nil
	ObjectiveTrackerFrame._shown = false
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "replace", "takes the tracker's place when it's empty")
	ObjectiveTrackerFrame._shown = true
	ns.db.settings.trackerPoint = { "CENTER", "CENTER", 10, 10 }
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "custom", "a dragged position is kept")
	ns.db.settings.trackerPoint = nil
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "below", "reset reattaches it")

	-- A link that goes stale on its own clock, with no update arriving to say so, still
	-- reaches the tracker: the once-a-second tick notices the state changed.
	-- The notice shows only beside a thread, and the snapshot may have none running.
	local savedThreads = ns.Store.data.threads
	ns.Store.data.threads = { { id = "w1", title = "Working", s = "working", st = time() - 60, p = "p" } }
	ns.Transport.bridgeNow = time() - 1000
	ns.Tracker:RefreshTimers()
	local found = false
	for _, b in ipairs(f.Lines) do
		if b._shown and b.Title:GetText():find("Connection lost", 1, true) then found = true end
	end
	check(found, "the tracker says the connection was lost")
	ns.Transport.bridgeNow = time()
	ns.Tracker:RefreshTimers()
	found = false
	for _, b in ipairs(f.Lines) do
		if b._shown and b.Title:GetText():find("Connection lost", 1, true) then found = true end
	end
	check(not found, "and that it is back")
	ns.Store.data.threads = savedThreads
	ns.Tracker:Refresh()
end

-- Minimap button
do
	local mb = ns.MinimapButton.button
	check(mb ~= nil, "minimap button created")
	local wasOpen = ns.windowOpen
	mb._scripts.OnClick(mb, "LeftButton")
	check(ns.windowOpen ~= wasOpen, "minimap click toggles the window")
	mb._scripts.OnClick(mb, "LeftButton")
	mb._scripts.OnEnter(mb)
	mb._scripts.OnDragStart(mb)
	mb._scripts.OnDragStop(mb)
	check(type(ns.db.settings.minimapAngle) == "number", "minimap drag saves its position")
	ns.db.settings.minimapButton = false
	ns.MinimapButton:Refresh()
	check(mb._shown == false, "minimap button can be hidden")
	ns.db.settings.minimapButton = true
	ns.MinimapButton:Refresh()
	-- Waiting on a watched PR isn't "needs you": no badge for it, but there is for input.
	local saved = ns.Store.data.threads
	ns.Store.data.threads = { { id = "w1", title = "Waiting", s = "waiting", l = "Watching pull request #7", st = time() - 60, p = "p" } }
	ns.MinimapButton:Refresh()
	check(not mb.Badge:IsShown(), "a waiting thread doesn't badge the minimap button")
	mb._scripts.OnEnter(mb)
	ns.Tracker:Refresh()
	check(ns.Store.GROUP_OF.waiting == "working", "waiting threads are listed under Working")
	check(ns.Store.GROUP_OF.input == "open" and ns.Store.GROUP_OF.plan == "open", "threads that need you are listed under Open, as in T3 Code")
	ns.Store.data.threads[2] = { id = "i1", title = "Input", s = "input", l = "Needs your approval", p = "p" }
	ns.MinimapButton:Refresh()
	check(mb.Badge:IsShown(), "a thread that needs the player badges the minimap button")
	ns.Store.data.threads = saved
	ns.MinimapButton:Refresh()
	ns.Tracker:Refresh()
end

-- Exhaustion
Stub.now = Stub.now + 2
ns.Transport.slotCursor = ns.Transport.slotCount + 1
ns.Transport:LoadNextSlot("signal")
check(ns.Transport:BridgeState() == "exhausted", "slot exhaustion detected")
ns.Tracker:Refresh()

print("\nall smoke checks passed; slots loaded: " .. tostring(Stub.loadCount))
