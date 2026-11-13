-- The WoW Assistant as a chat tab, where the conversation reads the way whispers do:
--   * with Chattynator, a custom tab ("WoW Assistant", added from its Special tabs
--     setting) drawn by this addon, with a box of its own at the bottom;
--   * with the game's own chat, a docked chat window of that name, made once and left
--     empty; this addon draws the conversation and its box inside it, the same view as
--     Chattynator's tab, so nothing sits where the game's own chat box goes.
-- `/ai <question>` asks from any chat box.
--
-- Any other agent can be pinned to a chat tab of its own the same way (the game's own
-- chat only): its conversation as whispers, and a box to reply in. While a pinned tab
-- shows, the addon tells the bridge (`watch`), which then sends that agent's last few
-- messages with each update (`chats`).
--
-- The game's own chat box isn't redirected: changing its text from an addon taints it,
-- which can get the player's ordinary chat blocked. The tab's box is separate.

local _, ns = ...

local C = {}
ns.ChatTab = C

C.ID = "orca_assistant"
C.LABEL = "WoW Assistant"
C.views = {}

-- The assistant's lines in Orca blue, the player's in the game's whisper colour, so the
-- two sides read apart at a glance.
C.ASSISTANT_COLOR = { 0.45, 0.72, 1 }
local function Colors()
	local wi = ChatTypeInfo and ChatTypeInfo.WHISPER_INFORM
	return C.ASSISTANT_COLOR, wi and { wi.r, wi.g, wi.b } or { 1, 0.5, 1 }
end

-- Whether the assistant's tab shows anywhere right now.
function C:IsVisible()
	for _, v in ipairs(self.views) do
		if not v.threadId and v:IsVisible() then return true end
	end
	return false
end

-- Whether a pinned agent's tab shows right now.
function C:IsShowingThread(id)
	for _, v in ipairs(self.views) do
		if v.threadId == id and v:IsVisible() then return true end
	end
	return false
end

---------------------------------------------------------------------------
-- The game's own chat: a docked window called "WoW Assistant"

local function ok(success, ...)
	if success then return ... end
end
local function try(fn, ...)
	if type(fn) == "function" then return ok(pcall(fn, ...)) end
end

-- The open chat window with this name, if the player has one.
function C:FindWindow(label)
	local info = FCF_GetChatWindowInfo or GetChatWindowInfo
	for i = 1, NUM_CHAT_WINDOWS or 10 do
		local name, _, _, _, _, _, shown, _, docked = try(info, i)
		if name == label and (shown or docked) then return _G["ChatFrame" .. i] end
	end
end

function C:FindNative()
	return self:FindWindow(C.LABEL)
end

-- Only the assistant's lines: no say, guild, loot, channels or system messages.
local function Quiet(frame)
	if frame.RemoveAllMessageGroups then try(frame.RemoveAllMessageGroups, frame) else try(ChatFrame_RemoveAllMessageGroups, frame) end
	if frame.RemoveAllChannels then try(frame.RemoveAllChannels, frame) else try(ChatFrame_RemoveAllChannels, frame) end
end

-- The window, made the first time (unless `force` is false and the player closed it once
-- before: then only /orca tab brings it back). Not in combat: chat windows are the game's.
function C:EnsureNative(force)
	if Chattynator and Chattynator.API then return nil end
	local frame = self:FindNative()
	if not frame and (force or not ns.db.chatTabMade) then
		if InCombatLockdown and InCombatLockdown() then return nil end
		frame = try(FCF_OpenNewWindow, C.LABEL, true)
		if frame then
			Quiet(frame)
			ns.db.chatTabMade = true
		end
	end
	if frame and self.native ~= frame then
		self.native = frame
		-- The window stays empty: the view drawn over it shows the conversation.
		Quiet(frame)
		self:Install(frame)
	end
	return frame
end

function C:Register()
	if self.registered then return end
	local api = Chattynator and Chattynator.API
	if not (api and api.RegisterCustomTab) then return end
	self.registered = true
	api.RegisterCustomTab(C.LABEL, C.ID, function(parent) C:Install(parent) end)
end

-- Chattynator calls this each time it shows the tab, possibly on a different window's
-- holder, so a view is made once per holder. `threadId` and `label` make it a pinned
-- agent's view instead of the assistant's.
function C:Install(parent, threadId, label)
	for _, v in ipairs(self.views) do
		if v:GetParent() == parent then
			v:Show()
			self:Render(v, true)
			return v
		end
	end
	local view = CreateFrame("Frame", nil, parent)
	view.threadId, view.label = threadId, label or C.LABEL
	view:SetAllPoints(parent)
	view:SetFrameLevel((parent:GetFrameLevel() or 0) + 5)

	local msgs = CreateFrame("ScrollingMessageFrame", nil, view)
	msgs:SetPoint("TOPLEFT", 4, -4)
	msgs:SetPoint("BOTTOMRIGHT", -4, 30)
	msgs:SetFontObject(ChatFontNormal)
	msgs:SetJustifyH("LEFT")
	msgs:SetFading(false)
	msgs:SetMaxLines(400)
	msgs:SetIndentedWordWrap(true)
	msgs:EnableMouseWheel(true)
	-- Three lines a notch, as the game's chat does with its default settings.
	msgs:SetScript("OnMouseWheel", function(self, delta)
		for _ = 1, 3 do
			if delta > 0 then self:ScrollUp() else self:ScrollDown() end
		end
	end)
	msgs:SetHyperlinksEnabled(true)
	msgs:SetScript("OnHyperlinkClick", function(_, link, text, button)
		if SetItemRef then SetItemRef(link, text, button) end
	end)
	view.Messages = msgs

	local box = CreateFrame("EditBox", nil, view, "InputBoxTemplate")
	box:SetAutoFocus(false)
	box:SetMaxLetters(1000)
	box:SetHeight(22)
	box:SetFontObject(ChatFontNormal)
	box:SetPoint("BOTTOMLEFT", 10, 4)
	box:SetPoint("BOTTOMRIGHT", -22, 4)
	box:SetScript("OnEnterPressed", ns.Safe(function(self)
		local text = strtrim(self:GetText() or "")
		if text ~= "" then
			if view.threadId then C:SendTo(view, text) else ns.AskPanel:Send(text) end
		end
		self:SetText("")
		self:ClearFocus()
	end))
	box:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	local hint = box:CreateFontString(nil, "ARTWORK", "GameFontDisable")
	hint:SetPoint("LEFT", 2, 0)
	hint:SetText(threadId and ("Reply to " .. view.label .. "…") or "Whisper the WoW Assistant…")
	box:SetScript("OnTextChanged", function(self) hint:SetShown(self:GetText() == "" and not self:HasFocus()) end)
	box:SetScript("OnEditFocusGained", function() hint:Hide() end)
	box:SetScript("OnEditFocusLost", function(self) hint:SetShown(self:GetText() == "") end)
	view.Box = box

	local function Visibility()
		if view.threadId then C:UpdateWatch() else ns.AskPanel:UpdateOpen() end
	end
	view:SetScript("OnShow", ns.Safe(function()
		Visibility()
		C:Render(view, true)
	end))
	view:SetScript("OnHide", ns.Safe(Visibility))
	table.insert(self.views, view)
	Visibility()
	self:Render(view, true)
	return view
end

-- The conversation as whispers: "To [WoW Assistant]: …" for the player's, "[WoW
-- Assistant] whispers: …" for answers, and a line while it's working. Redrawn only when
-- it changed, so reading back through it isn't interrupted.
function C:Render(view, force)
	local entries, status
	if view.threadId then entries, status = self:ThreadEntries(view) else entries, status = ns.AskPanel:Entries() end
	local key = {}
	for _, e in ipairs(entries) do table.insert(key, e.r .. e.t) end
	table.insert(key, status or "")
	key = table.concat(key, "\001")
	if not force and view.key == key then return end
	view.key = key
	local inColor, outColor = Colors()
	local msgs = view.Messages
	msgs:Clear()
	if #entries == 0 and not view.threadId then
		msgs:AddMessage(ns.Color("grey", "Ask the WoW Assistant anything about the game. It sees your character, location, quests and talents; shift-click items into the box to compare them."))
	end
	-- One chat line per line of a message: the frame scrolls by line, so a long answer
	-- added whole could only be read by making the window taller than it.
	for _, e in ipairs(entries) do
		local color = e.r == "u" and outColor or inColor
		local prefix = e.r == "u" and ("To [" .. view.label .. "]: ") or ("[" .. view.label .. "] whispers: ")
		local first = true
		for line in (tostring(e.t) .. "\n"):gmatch("(.-)\n") do
			if first or line ~= "" then
				msgs:AddMessage((first and prefix or "   ") .. line, color[1], color[2], color[3])
			end
			first = false
		end
	end
	if status then msgs:AddMessage(status) end
	msgs:ScrollToBottom()
end

-- The key binding: show the assistant's chat tab and put the cursor in its box. The
-- focus waits a frame, so the bound key itself isn't typed into the box.
function C:Focus()
	local view
	if self.native then
		if not self:FindNative() then self.native = nil end
	end
	if not self.native and not (Chattynator and Chattynator.API) then self:EnsureNative(true) end
	if self.native then
		if FCF_SelectDockFrame then pcall(FCF_SelectDockFrame, self.native) end
		if not self.native:IsShown() then self.native:Show() end
		for _, v in ipairs(self.views) do if v:GetParent() == self.native then view = v end end
	else
		for _, v in ipairs(self.views) do if not v.threadId and v:IsVisible() then view = v end end
	end
	if not view then
		-- Chattynator's tab can't be picked from here unless it's already showing: the Ask
		-- panel does the same job.
		ns.AskPanel:Open()
		C_Timer.After(0, function() if ns.AskPanel.box then ns.AskPanel.box:SetFocus() end end)
		return
	end
	view:Show()
	C_Timer.After(0, function() view.Box:SetFocus() end)
end

---------------------------------------------------------------------------
-- Pinned agents

-- A chat tab's name: the agent's title, short enough for a tab.
local function TabName(title)
	local name = tostring(title or "Agent"):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
	name = strtrim(name)
	if #name > 22 then name = strtrim(name:sub(1, 21)) .. "…" end
	return name
end

function C:IsPinned(id)
	return id ~= nil and ns.db.pinned ~= nil and ns.db.pinned[id] ~= nil
end

-- Pin an agent to a chat tab of its own (the game's own chat; Chattynator can't take one).
function C:Pin(id)
	local t = ns.Store:Thread(id)
	if not t then return end
	if Chattynator and Chattynator.API then
		ns.Print("Pinned chat tabs need the game's own chat. With Chattynator, use the Orca window.")
		return
	end
	if InCombatLockdown and InCombatLockdown() then
		ns.Print("Pin it after combat: chat tabs can't be made during a fight.")
		return
	end
	local label = TabName(t.title)
	local frame = self:FindWindow(label) or try(FCF_OpenNewWindow, label, true)
	if not frame then
		ns.Print("Couldn't make a chat tab: the game allows ten chat windows. Close one and try again.")
		return
	end
	Quiet(frame)
	ns.db.pinned = ns.db.pinned or {}
	ns.db.pinned[id] = label
	self:Install(frame, id, label)
	if FCF_SelectDockFrame then pcall(FCF_SelectDockFrame, frame) end
	ns.Print("Pinned " .. ns.Color("white", label) .. " to a chat tab.")
end

function C:Unpin(id)
	for i, v in ipairs(self.views) do
		if v.threadId == id then
			local frame = v:GetParent()
			v:Hide()
			table.remove(self.views, i)
			if FCF_Close then try(FCF_Close, frame) end
			break
		end
	end
	if ns.db.pinned then ns.db.pinned[id] = nil end
	self:UpdateWatch()
end

-- After login: put the views back on pinned agents' tabs. A tab the player closed in the
-- meantime unpins its agent.
function C:RestorePinned()
	if Chattynator and Chattynator.API then return end
	for id, label in pairs(ns.db.pinned or {}) do
		local frame = self:FindWindow(label)
		if frame then self:Install(frame, id, label) else ns.db.pinned[id] = nil end
	end
end

-- Tell the bridge which pinned agents' tabs show, so it sends their conversations; a
-- moment later, so a burst of tab switching becomes one command.
function C:UpdateWatch()
	if self.watchPending then return end
	self.watchPending = true
	C_Timer.After(0.2, function()
		self.watchPending = nil
		local ids = {}
		for _, v in ipairs(self.views) do
			if v.threadId and v:IsVisible() then table.insert(ids, v.threadId) end
		end
		table.sort(ids)
		local key = table.concat(ids, ",")
		if key == (self.lastWatch or "") then return end
		self.lastWatch = key
		if key == "" then ns.Transport:Send("watch") else ns.Transport:Send("watch", key) end
	end)
end

-- A pinned agent's conversation, as the assistant's: the last few messages, the reply
-- just sent until the bridge has it, and what it's doing.
function C:ThreadEntries(view)
	local v = ns.Store.data.chats and ns.Store.data.chats[view.threadId]
	local entries = {}
	local msgs = v and v.msgs or {}
	for _, m in ipairs(msgs) do table.insert(entries, { r = m.r, t = m.t }) end
	local echo = view.echo
	if echo then
		local found, answered
		for i = #msgs, 1, -1 do
			if msgs[i].r == "u" and msgs[i].at and msgs[i].at >= echo.since - 5 then
				found = true
				for j = i + 1, #msgs do if msgs[j].r == "a" then answered = true end end
				break
			end
		end
		if answered then view.echo = nil elseif not found then table.insert(entries, { r = "u", t = echo.q }) end
	end
	local status
	local t = ns.Store:Thread(view.threadId)
	if not t then
		status = ns.Color("grey", view.label .. " is gone from Orca.")
	elseif ns.Store:ReadOnly(t) then
		status = ns.Color("grey", view.label .. " runs in a terminal: watch only.")
	elseif v and v.ask then
		status = ns.Color("orange", view.label .. " needs you: open it in the Orca window to answer.")
	elseif v and v.act then
		status = ns.Color("grey", view.label .. " is working: " .. v.act)
	elseif view.echo then
		status = ns.Color("grey", view.label .. " is thinking…")
	elseif not v then
		status = ns.Color("grey", "Loading…")
	end
	return entries, status
end

-- A reply from a pinned agent's tab: sent as in the Orca window.
function C:SendTo(view, text)
	local t = ns.Store:Thread(view.threadId)
	if not t then
		ns.Print(view.label .. " is gone from Orca.")
		return
	end
	if ns.Store:ReadOnly(t) then
		ns.Print(view.label .. " runs in a terminal, so the game can only watch it. Reply to it in Orca.")
		return
	end
	local clean = ns.GameContext.Clean(text)
	local id
	if ns.db.settings.steerFollowUps then
		id = ns.Transport:Send("send", view.threadId, clean, "steer")
	else
		id = ns.Transport:Send("send", view.threadId, clean)
	end
	if not id then return end
	view.echo = { q = clean, since = time() }
	self:Render(view, true)
end

function C:RenderAll()
	for _, v in ipairs(self.views) do
		if v:IsVisible() then self:Render(v) end
	end
end

-- A whisper-style line in the ordinary chat, for an answer to /ai while the tab and the
-- panel are both closed.
function C:PrintAnswer(text)
	local inColor = Colors()
	local frame = DEFAULT_CHAT_FRAME
	if frame then frame:AddMessage("[" .. C.LABEL .. "] whispers: " .. text, inColor[1], inColor[2], inColor[3]) end
end

ns:On("DataChanged", function() C:RenderAll() end)

-- /ai <question>: ask from any chat box; the answer comes back as a whisper.
SLASH_ORCAAI1 = "/ai"
SlashCmdList.ORCAAI = function(msg)
	msg = strtrim(msg or "")
	if msg == "" then
		ns.AskPanel:Open()
		return
	end
	ns.AskPanel:Send(msg)
end

-- Chattynator loads before Orca (by name), but in case it loads later, register then.
C:Register()
local watcher = CreateFrame("Frame")
watcher:RegisterEvent("ADDON_LOADED")
watcher:SetScript("OnEvent", function(_, _, name) if name == "Chattynator" then C:Register() end end)

-- Without Chattynator: the game's own chat window, once the game has set its windows up.
ns:On("EnteringWorld", function()
	C_Timer.After(2, function()
		if ns.db.settings.chatTab ~= false and ns.Store:IsOrca() then C:EnsureNative(false) end
		C:RestorePinned()
	end)
end)
ns:On("DataChanged", function()
	if not C.native and not C.tried and ns.db.settings.chatTab ~= false and ns.Store:IsOrca() then
		C.tried = true
		C_Timer.After(2, function() C:EnsureNative(false) end)
	end
end)
