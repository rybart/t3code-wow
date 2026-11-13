-- The quick way to ask the WoW Assistant: a floating icon the player can drag anywhere,
-- which opens a small panel with the latest exchange and a box to ask the next question.
-- It talks to the same Orca chat as the full window; the full window stays for anything
-- longer (answering the assistant's questions, older messages).
--
-- While the panel is open the addon says so in its hello (flag "k"), and the bridge
-- sends the assistant's last few messages with each update (`askv`).

local _, ns = ...
local UI = ns.UI

local A = {}
ns.AskPanel = A

local W, H = 400, 330
local ICON = 40

local function SavePoint(frame, key)
	local point, _, rel, x, y = frame:GetPoint()
	ns.db.settings[key] = { point, rel, x, y }
end

local function RestorePoint(frame, key, default)
	frame:ClearAllPoints()
	local p = ns.db.settings[key]
	if type(p) == "table" and p[1] then
		frame:SetPoint(p[1], UIParent, p[2] or p[1], p[3] or 0, p[4] or 0)
	else
		frame:SetPoint(unpack(default))
	end
end

local function Draggable(frame, handle, key, onClick)
	frame:SetMovable(true)
	frame:SetClampedToScreen(true)
	handle:EnableMouse(true)
	handle:RegisterForDrag("LeftButton")
	handle:SetScript("OnDragStart", function() frame:StartMoving() end)
	handle:SetScript("OnDragStop", function()
		frame:StopMovingOrSizing()
		frame:SetUserPlaced(false)
		SavePoint(frame, key)
	end)
end

---------------------------------------------------------------------------
-- The floating icon

function A:CreateIcon()
	if self.icon then return self.icon end
	local b = CreateFrame("Button", "OrcaAskButton", UIParent)
	b:SetSize(ICON, ICON)
	b:SetFrameStrata("MEDIUM")
	b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	local tex = b:CreateTexture(nil, "ARTWORK")
	tex:SetAllPoints()
	tex:SetTexture(ns.media .. "portrait")
	b.Icon = tex
	b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
	-- An answer came in while the panel was closed.
	local badge = b:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	badge:SetPoint("CENTER", b, "TOPRIGHT", -6, -6)
	badge:SetText("!")
	badge:Hide()
	b.Badge = badge
	Draggable(b, b, "askIconPoint")
	b:SetScript("OnClick", ns.Safe(function(_, button)
		if button == "RightButton" then
			ns.Main:OpenAssistant()
		else
			A:Toggle()
		end
	end))
	UI.Tooltip(b, "WoW Assistant", "Click to ask a question about the game. Drag to move. Right-click opens the full conversation.")
	RestorePoint(b, "askIconPoint", { "RIGHT", UIParent, "RIGHT", -60, 120 })
	self.icon = b
	self:RefreshIcon()
	return b
end

function A:RefreshIcon()
	if not self.icon then return end
	self.icon:SetShown(ns.db.settings.askIcon ~= false and ns.Store:IsOrca())
end

---------------------------------------------------------------------------
-- The panel

function A:Create()
	if self.frame then return self.frame end
	local f = CreateFrame("Frame", "OrcaAskPanel", UIParent, "BackdropTemplate")
	f:SetSize(W, H)
	f:SetFrameStrata("DIALOG")
	f:SetBackdrop({
		bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Gold-Border",
		tile = true, tileSize = 32, edgeSize = 24,
		insets = { left = 6, right = 6, top = 6, bottom = 6 },
	})
	f:Hide()
	-- Escape closes it, like the game's own panels.
	tinsert(UISpecialFrames, "OrcaAskPanel")

	local title = UI.Text(f, "GameFontNormal", "LEFT")
	title:SetPoint("TOPLEFT", 16, -14)
	title:SetText("WoW Assistant")
	f.Title = title
	Draggable(f, f, "askPanelPoint")

	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", -2, -2)
	close:SetScript("OnClick", function() A:Close() end)

	local full = UI.Button(f, "Full view", 80, function()
		A:Close()
		ns.Main:OpenAssistant()
	end)
	full:SetPoint("RIGHT", close, "LEFT", -2, 0)
	UI.Tooltip(full, "Full view", "Open the whole conversation in the Orca window.")

	-- The conversation: the latest exchanges, newest at the bottom.
	local scroll = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", 14, -38)
	scroll:SetPoint("BOTTOMRIGHT", -32, 74)
	local content = CreateFrame("Frame", nil, scroll)
	content:SetSize(W - 50, 10)
	scroll:SetScrollChild(content)
	local text = UI.Text(content, "GameFontHighlight", "LEFT")
	text:SetPoint("TOPLEFT")
	text:SetWidth(W - 54)
	text:SetJustifyV("TOP")
	text:SetSpacing(2)
	f.Scroll, f.Content, f.Text = scroll, content, text

	local status = UI.Text(f, "GameFontDisableSmall", "LEFT")
	status:SetPoint("BOTTOMLEFT", 18, 52)
	status:SetPoint("RIGHT", -18, 0)
	f.Status = status

	local box = CreateFrame("EditBox", nil, f, "InputBoxTemplate")
	box:SetAutoFocus(false)
	box:SetMaxLetters(1000)
	box:SetHeight(24)
	box:SetPoint("BOTTOMLEFT", 22, 18)
	box:SetPoint("BOTTOMRIGHT", -150, 18)
	box:SetScript("OnEnterPressed", ns.Safe(function() A:Send() end))
	box:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	f.Box = box
	self.box = box

	local shot = UI.IconButton(f, "Interface\\Icons\\INV_Misc_Spyglass_03", 24, nil, function() A:Screenshot() end)
	shot:SetPoint("LEFT", box, "RIGHT", 8, 0)
	UI.Tooltip(shot, "Attach a screenshot", "Adds a screenshot of the game to your next question.")
	f.Shot = shot

	local ask = UI.Button(f, "Ask", 80, function() A:Send() end)
	ask:SetPoint("LEFT", shot, "RIGHT", 6, 0)
	f.Ask = ask

	f:SetScript("OnShow", ns.Safe(function()
		ns.askOpen = true
		if A.icon then A.icon.Badge:Hide() end
		ns.Transport:Touch()
		A:Refresh()
		-- The elapsed time while the assistant works.
		A.ticker = C_Timer.NewTicker(1, function() A:Refresh() end)
	end))
	f:SetScript("OnHide", ns.Safe(function()
		ns.askOpen = false
		if A.ticker then A.ticker:Cancel() A.ticker = nil end
		ns.Transport:Touch()
	end))
	RestorePoint(f, "askPanelPoint", { "CENTER", UIParent, "CENTER", 260, 60 })
	self.frame = f
	return f
end

function A:Open()
	if not ns.Store:IsOrca() then
		ns.Print("The assistant needs the bridge to be watching Orca.")
		return
	end
	self:Create():Show()
	self.box:SetFocus()
end

function A:Close()
	if self.frame then self.frame:Hide() end
end

function A:Toggle()
	if self.frame and self.frame:IsShown() then self:Close() else self:Open() end
end

function A:IsOpen()
	return self.frame ~= nil and self.frame:IsShown()
end

-- The assistant's thread, once its chat exists.
function A:ThreadId()
	local b = ns.Store.data.bridge
	local id = b and b.asst
	if id and ns.Store:Thread(id) then return id end
end

function A:Send(textOverride)
	local text = strtrim(textOverride or (self.box and self.box:GetText()) or "")
	if text == "" then return end
	local id = self:ThreadId()
	local sent
	if id then
		local message = ns.GameContext.Build(text, function(m) return ns.Transport:Fits("send", id, m) end)
		sent = ns.Transport:Send("send", id, message)
	else
		local message = ns.GameContext.Build(text, function(m) return ns.Transport:Fits("assistant", m) end)
		sent = ns.Transport:Send("assistant", message)
	end
	if not sent then return end -- too long; the box keeps it
	-- Shown at once; the bridge's copy replaces it when it arrives.
	self.echo = { q = ns.GameContext.Clean(text), since = time(), answers = self:AnswerCount() }
	self.shots = nil
	if self.box then
		self.box:SetText("")
		self.box:ClearFocus()
	end
	PlaySound(SOUNDKIT.TELL_MESSAGE or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	self:Refresh()
end

-- Screenshots go with the next question: to the assistant's chat, or to the new chat
-- the first question starts.
function A:Screenshot()
	ns.Transport:Send("shot", self:ThreadId() or "new")
	self.shots = (self.shots or 0) + 1
	self:Refresh()
end

function A:AnswerCount()
	local n = 0
	local v = ns.Store.data.askv
	for _, m in ipairs(v and v.msgs or {}) do
		if m.r == "a" then n = n + 1 end
	end
	return n
end

-- What the conversation area shows: the last few exchanges, then the question just sent
-- until the bridge has it.
function A:Lines()
	local v = ns.Store.data.askv
	local lines = {}
	for _, m in ipairs(v and v.msgs or {}) do
		if m.r == "u" then
			table.insert(lines, ns.Color("gold", "You: ") .. m.t)
		else
			table.insert(lines, m.t)
		end
	end
	local echo = self.echo
	if echo then
		local last = v and v.msgs and v.msgs[#v.msgs]
		local arrived = last and last.r == "u" and last.at and last.at >= echo.since - 5
		if self:AnswerCount() > echo.answers then
			self.echo = nil
		elseif not arrived then
			table.insert(lines, ns.Color("gold", "You: ") .. echo.q)
		end
	end
	if #lines == 0 then
		return ns.Color("grey", "Ask anything about the game: why it looks dark, which of two items is better (shift-click them into the box), where to go for a quest. It sees your character, location, quests and talents.")
	end
	return table.concat(lines, "\n\n")
end

function A:Refresh()
	local f = self.frame
	if not f or not f:IsShown() then return end
	local v = ns.Store.data.askv
	local wasAtBottom = (f.Scroll:GetVerticalScrollRange() or 0) - (f.Scroll:GetVerticalScroll() or 0) < 20
	f.Text:SetText(self:Lines())
	f.Content:SetHeight(math.max(10, f.Text:GetStringHeight() + 4))
	if wasAtBottom or self.echo then
		C_Timer.After(0, function() f.Scroll:SetVerticalScroll(f.Scroll:GetVerticalScrollRange() or 0) end)
	end
	local status
	if v and v.ask then
		status = ns.Color("orange", "The assistant asked you something: open Full view to answer.")
	elseif v and v.act then
		status = ns.Color("agent", v.act) .. (v.st and ns.Color("grey", "  " .. ns.Duration(time() - v.st)) or "")
	elseif self.echo then
		status = ns.Color("agent", "Thinking…")
	elseif v and v.loading then
		status = ns.Color("grey", "Loading…")
	end
	if self.shots and self.shots > 0 then
		status = (status and (status .. "  ·  ") or "") .. ns.Color("gold", self.shots .. (self.shots == 1 and " screenshot attached" or " screenshots attached"))
	end
	f.Status:SetText(status or "")
end

ns:On("DataChanged", function()
	A:RefreshIcon()
	A:Refresh()
end)

-- An answer while the panel is closed: a mark on the icon until it's opened.
ns:On("ThreadTransition", function(t, before, after)
	if A.icon and not A:IsOpen() and ns.Store:IsAssistant(t.id) and (after == "open" or after == "input") and before ~= after then
		A.icon.Badge:Show()
	end
end)

ns:On("EnteringWorld", function() A:CreateIcon() end)
