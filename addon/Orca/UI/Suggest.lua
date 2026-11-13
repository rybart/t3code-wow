-- Suggestions above the message box, as in T3 Code's composer: "/" lists the provider's
-- slash commands and "$" its skills, filtered as you type. A pick is plain text. T3
-- runs a skill named "$name" anywhere in the message; "/name" only at its start.

local _, ns = ...

local S = {}
ns.Suggest = S

local ROWS = 8
local ROW_H = 20

-- nil while closed, else { trigger, from, to, cursor, query, list, view, matches, index, offset }:
-- `from` and `to` are the token's first and last byte, `index` the highlighted match
-- and `offset` the first one on screen.
S.state = nil

---------------------------------------------------------------------------
-- Text

-- The "/" or "$" token the cursor sits in or right after: its trigger, first and
-- last byte, and what's typed between the trigger and the cursor. Like T3, a token
-- starts the text or follows whitespace. Cursor positions are byte offsets.
function S.TokenAt(text, cursor)
	text = text or ""
	cursor = math.min(cursor or #text, #text)
	local from = cursor
	while from > 0 and not text:sub(from, from):find("%s") do from = from - 1 end
	from = from + 1
	if from > cursor then return nil end
	local trigger = text:sub(from, from)
	if trigger ~= "/" and trigger ~= "$" then return nil end
	local to = cursor
	while to < #text and not text:sub(to + 1, to + 1):find("%s") do to = to + 1 end
	return trigger, from, to, text:sub(from + 1, cursor)
end

-- Entries for one trigger whose name has the query, ignoring case: names that start
-- with it first, then names that contain it, each in T3's order.
function S.Filter(list, trigger, query)
	query = (query or ""):lower()
	local starts, contains = {}, {}
	for _, e in ipairs(list or {}) do
		if type(e.t) == "string" and e.t:sub(1, 1) == trigger then
			local name = e.t:sub(2):lower()
			if name:sub(1, #query) == query then
				table.insert(starts, e)
			elseif name:find(query, 1, true) then
				table.insert(contains, e)
			end
		end
	end
	for _, e in ipairs(contains) do table.insert(starts, e) end
	return starts
end

-- Bytes `from`..`to` replaced by an entry's text and a space. A space or line break
-- already after the token takes the place of ours. Returns the text and the cursor.
function S.Replace(text, from, to, insert)
	local before, after = text:sub(1, from - 1), text:sub(to + 1)
	insert = insert:gsub("||", "|")
	if after:find("^%s") then
		return before .. insert .. after, #before + #insert + 1
	end
	insert = insert .. " "
	return before .. insert .. after, #before + #insert
end

---------------------------------------------------------------------------
-- The list

local function Composer() return ns.Main.composer end

local function ViewKey()
	return ns.Main.mode == "new" and "new" or (ns.viewId or "")
end

local function CurrentList()
	return ns.Store:Commands(ns.Main:NextProvider())
end

function S:Close()
	local was = self.state ~= nil
	self.state = nil
	if self.frame then self.frame:Hide() end
	return was
end

function S:Update()
	local composer = Composer()
	if not composer or not composer:IsVisible() or not composer:HasFocus() then return self:Close() end
	local text = composer:GetInputText() or ""
	local cursor = composer:GetEditBox():GetCursorPosition() or #text
	local trigger, from, to, query = S.TokenAt(text, cursor)
	if not trigger then return self:Close() end
	local list = CurrentList()
	local matches = S.Filter(list, trigger, query)
	if #matches == 0 then return self:Close() end
	local old = self.state
	local same = old and old.list == list and old.trigger == trigger and old.from == from and old.query == query
	self.state = {
		trigger = trigger, from = from, to = to, cursor = cursor, query = query, list = list, view = ViewKey(),
		matches = matches,
		index = same and math.min(old.index, #matches) or 1,
		offset = same and math.min(old.offset, math.max(1, #matches - ROWS + 1)) or 1,
	}
	self:Render()
end

-- The composer's text changed. Text the addon set (a loaded draft, a sent message)
-- closes the list; only typing opens it.
function S:OnTextChanged(userChanged)
	if self.filling then return end
	if userChanged == false then self:Close() else self:Update() end
end

-- Another thread, the new-thread page or another model's provider: the list was for
-- the message box as it was.
function S:Sync()
	local s = self.state
	if s and (s.view ~= ViewKey() or s.list ~= CurrentList()) then self:Close() end
end

-- The box reports its own SetText as a change with the cursor still at the end, which
-- could open the list again on whatever token ends the text.
local function Fill(text, cursor)
	local composer = Composer()
	S.filling = true
	composer:SetText(text)
	S.filling = nil
	composer:GetEditBox():SetCursorPosition(cursor)
	S:Close()
	composer:SetFocus()
end

function S:Pick(index)
	local s = self.state
	local e = s and s.matches[index]
	if not e then return end
	Fill(S.Replace(Composer():GetInputText() or "", s.from, s.to, e.t))
end

-- Tab or Enter. False when there's nothing to accept, so the key does its usual job.
function S:Accept()
	if not self.state then return false end
	-- The cursor may have left the token (a click in the box) since the list was drawn.
	self:Update()
	if not self.state then return false end
	self:Pick(self.state.index)
	return true
end

-- An entry put in at the cursor, as if typed there: the controller's way in.
function S:InsertAtCursor(t)
	local composer = Composer()
	local text = composer:GetInputText() or ""
	local cursor = math.min(composer:GetEditBox():GetCursorPosition() or #text, #text)
	local lead = (cursor > 0 and not text:sub(cursor, cursor):find("%s")) and " " or ""
	Fill(S.Replace(text, cursor + 1, cursor, lead .. t))
end

function S:Move(delta)
	local s = self.state
	if not s then return end
	s.index = (s.index - 1 + delta) % #s.matches + 1
	if s.index < s.offset then
		s.offset = s.index
	elseif s.index > s.offset + ROWS - 1 then
		s.offset = s.index - ROWS + 1
	end
	self:Render()
end

function S:Scroll(delta)
	local s = self.state
	if not s then return end
	s.offset = math.max(1, math.min(s.offset + delta, #s.matches - ROWS + 1))
	-- Tab takes the highlighted entry, so keep it among the rows you can see.
	s.index = math.max(s.offset, math.min(s.index, s.offset + ROWS - 1))
	self:Render()
end

---------------------------------------------------------------------------
-- Frame

function S:Frame()
	if self.frame then return self.frame end
	local main = ns.Main
	local inset = main.frame.Pages.threads.Right.ComposerInset
	local f = CreateFrame("Frame", nil, main.frame)
	f:SetFrameStrata("DIALOG")
	f:EnableMouse(true)
	f:EnableMouseWheel(true)
	f:SetPoint("BOTTOMLEFT", inset, "TOPLEFT", 0, 2)
	f:SetPoint("BOTTOMRIGHT", inset, "TOPRIGHT", 0, 2)
	f:Hide()
	local bg = f:CreateTexture(nil, "BACKGROUND")
	bg:SetAtlas("common-dropdown-bg")
	bg:SetPoint("TOPLEFT", -10, 3)
	bg:SetPoint("BOTTOMRIGHT", 10, -3)
	bg:SetAlpha(0.95)
	if not bg:GetAtlas() then bg:SetColorTexture(0.05, 0.05, 0.05, 0.95) end
	-- Solid behind the text: the transcript underneath would show through the art.
	local solid = f:CreateTexture(nil, "BACKGROUND", nil, -1)
	solid:SetAllPoints()
	solid:SetColorTexture(0.03, 0.03, 0.03, 1)

	f.Rows = {}
	for i = 1, ROWS do
		local row = CreateFrame("Button", nil, f)
		row:SetHeight(ROW_H)
		row:SetPoint("TOPLEFT", 6, -6 - (i - 1) * ROW_H)
		row:SetPoint("TOPRIGHT", -10, -6 - (i - 1) * ROW_H)
		local hl = row:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAtlas("Options_List_Hover")
		hl:SetAllPoints()
		hl:SetAlpha(0.6)
		row.Selected = row:CreateTexture(nil, "BACKGROUND")
		row.Selected:SetAtlas("Options_List_Hover")
		if not row.Selected:GetAtlas() then row.Selected:SetColorTexture(1, 1, 1, 0.15) end
		row.Selected:SetAllPoints()
		row.Text = row:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
		row.Text:SetPoint("LEFT", 8, 0)
		row.Text:SetPoint("RIGHT", -4, 0)
		row.Text:SetJustifyH("LEFT")
		row.Text:SetWordWrap(false)
		row:SetScript("OnClick", function(self) S:Pick(self.index) end)
		f.Rows[i] = row
	end
	f.Thumb = f:CreateTexture(nil, "ARTWORK")
	f.Thumb:SetColorTexture(1, 0.82, 0, 0.45)
	f.Thumb:SetWidth(3)

	f:SetScript("OnMouseWheel", function(_, delta) S:Scroll(delta > 0 and -3 or 3) end)
	f:SetScript("OnUpdate", function(self)
		if not S.state then return end
		local composer = Composer()
		if not composer:IsVisible() or (not composer:HasFocus() and not self:IsMouseOver()) then
			S:Close()
		elseif (IsMouseButtonDown("LeftButton") or IsMouseButtonDown("RightButton"))
			and not self:IsMouseOver() and not inset:IsMouseOver() then
			S:Close()
		end
	end)
	self.frame = f
	return f
end

function S:Render()
	local s = self.state
	if not s then return self:Close() end
	local f = self:Frame()
	local n = #s.matches
	local shown = math.min(ROWS, n)
	for i, row in ipairs(f.Rows) do
		local index = s.offset + i - 1
		local e = i <= shown and s.matches[index]
		if e then
			local current = index == s.index
			local name = current and ns.Color("gold", e.t) or e.t
			row.index = index
			row.Text:SetText(e.d and (name .. "   " .. ns.Color("grey", e.d)) or name)
			row.Selected:SetShown(current)
			row:Show()
		else
			row:Hide()
		end
	end
	local height = shown * ROW_H + 12
	f:SetHeight(height)
	if n > ROWS then
		local track = height - 12
		local thumb = math.max(12, track * ROWS / n)
		f.Thumb:SetHeight(thumb)
		f.Thumb:ClearAllPoints()
		f.Thumb:SetPoint("TOPRIGHT", -3, -6 - (track - thumb) * (s.offset - 1) / (n - ROWS))
		f.Thumb:Show()
	else
		f.Thumb:Hide()
	end
	f:Show()
end

---------------------------------------------------------------------------
-- Keys the composer's callbacks don't cover

function S:Attach(composer)
	local editBox = composer:GetEditBox()
	editBox:HookScript("OnTabPressed", ns.Safe(function() S:Accept() end))
	-- Measured in game: this multi-line box never fires OnArrowPressed, but OnKeyDown
	-- reports the arrows as "UP", "DOWN", "LEFT" and "RIGHT".
	editBox:HookScript("OnKeyDown", ns.Safe(function(_, key)
		local s = S.state
		if not s then return end
		if key == "UP" or key == "DOWN" then
			S:Move(key == "UP" and -1 or 1)
			-- In a message of several lines the box may also move its cursor up or down a
			-- line: put it back now and once the move has happened.
			local cursor = s.cursor
			editBox:SetCursorPosition(cursor)
			C_Timer.After(0, function() if S.state then editBox:SetCursorPosition(cursor) end end)
		elseif key == "LEFT" or key == "RIGHT" then
			C_Timer.After(0, function() if S.state then S:Update() end end)
		end
	end))
	editBox:HookScript("OnMouseUp", ns.Safe(function()
		if S.state then C_Timer.After(0, function() if S.state then S:Update() end end) end
	end))
end

ns:On("WindowHidden", function() S:Close() end)
