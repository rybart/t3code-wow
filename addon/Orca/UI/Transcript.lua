-- Right side of the window: the selected thread's conversation, what the agent is
-- doing right now, and anything it is waiting on you for.

local _, ns = ...
local UI = ns.UI

local T = {}
ns.Transcript = T

T.echo = {}      -- threadId -> { text, at, after } sent but not yet in a snapshot
T.answers = {}   -- requestId -> { [questionId] = { value = true, ... } }

local QUICK_REPLIES = {
	"Carry on.",
	"Looks good, thanks.",
	"Explain that more simply.",
	"Try a different approach.",
}

local BODY_FONT = "GameFontHighlight"
local PAD_X = 10

---------------------------------------------------------------------------
-- Measuring text so rows get the right height

local measurer
local BODY_SPACING = 2

local function Measure(text, width, font, spacing)
	if not measurer then
		measurer = UIParent:CreateFontString(nil, "BACKGROUND", BODY_FONT)
		measurer:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -5000, 5000)
		measurer:SetJustifyH("LEFT")
		measurer:SetAlpha(0)
	end
	measurer:SetFontObject(font or BODY_FONT)
	measurer:SetSpacing(spacing or 0)
	measurer:SetWidth(width)
	measurer:SetText(text)
	return math.ceil(measurer:GetStringHeight())
end

function T:BodyWidth()
	local w = self.scrollBox and self.scrollBox:GetWidth() or 560
	if w < 100 then w = 560 end
	return w - PAD_X * 2 - 26
end

---------------------------------------------------------------------------
-- Element initializers

local function InitMessage(frame, ed)
	if not frame.Body then
		frame.Label = frame:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
		frame.Label:SetPoint("TOPLEFT", PAD_X, -6)
		frame.Body = frame:CreateFontString(nil, "ARTWORK", BODY_FONT)
		frame.Body:SetPoint("TOPLEFT", frame.Label, "BOTTOMLEFT", 0, -4)
		frame.Body:SetJustifyH("LEFT")
		frame.Body:SetJustifyV("TOP")
		frame.Body:SetSpacing(BODY_SPACING)
		frame.Speak = UI.IconButton(frame, "voicechat-icon-speaker", 18, nil, nil)
		frame.Speak.Background:Hide()
		frame.Speak:SetPoint("TOPRIGHT", -6, -4)
		frame.Speak:SetAlpha(0.8)
		UI.Tooltip(frame.Speak, "Read aloud")
		frame.Time = frame:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
		frame.Time:SetPoint("RIGHT", frame.Speak, "LEFT", -6, 0)
	end
	local m = ed.msg
	if m.r == "u" then
		frame.Label:SetText(ns.Color("gold", ed.echo and "you  |cff9d9d9d(sending…)|r" or "you"))
	else
		frame.Label:SetText(ns.Color("agent", "agent") .. (m.live and ns.Color("grey", "  writing…") or ""))
	end
	frame.Body:SetWidth(T:BodyWidth())
	frame.Body:SetText(m.t)
	-- If the real text is taller than estimated (font or scale differences), grow the
	-- row and lay the list out again rather than letting the next row overlap it.
	local needed = 34 + math.ceil(frame.Body:GetStringHeight())
	if needed > (ed.height or 0) + 1 then
		ed.height = needed
		T.heightFix[ed.fixKey] = needed
		if not T.reflowQueued then
			T.reflowQueued = true
			C_Timer.After(0, function()
				T.reflowQueued = nil
				T:Reflow()
			end)
		end
	end
	frame.Time:SetText(m.at and date("%H:%M", m.at) or "")
	frame.Speak:SetShown(m.r == "a")
	frame.Speak:SetScript("OnClick", function() ns.Speak(m.t, ns.viewId, m.n) end)
end

local function InitNote(frame, ed)
	if not frame.Text then
		frame.Icon = frame:CreateTexture(nil, "ARTWORK")
		frame.Icon:SetSize(16, 16)
		frame.Icon:SetPoint("TOPLEFT", PAD_X, -6)
		frame.Text = frame:CreateFontString(nil, "ARTWORK", "GameFontNormal")
		frame.Text:SetPoint("TOPLEFT", frame.Icon, "TOPRIGHT", 6, 0)
		frame.Text:SetJustifyH("LEFT")
		frame.Text:SetJustifyV("TOP")
		frame.Anim = frame.Icon:CreateAnimationGroup()
		local rot = frame.Anim:CreateAnimation("Rotation")
		rot:SetDegrees(-360)
		rot:SetDuration(1.4)
		frame.Anim:SetLooping("REPEAT")
	end
	frame.Text:SetWidth(T:BodyWidth() - 22)
	local text = ed.text
	if ed.since then text = string.format("%s  |cff9d9d9d(%s)|r", text, ns.Duration(time() - ed.since)) end
	frame.Text:SetText(text)
	frame.Icon:SetAtlas(ed.icon or "common-icon-forwardarrow")
	if ed.spin then frame.Anim:Play() else frame.Anim:Stop() end
end

local function InitOption(button, ed)
	if not button.Label then
		button.Bullet = button:CreateTexture(nil, "ARTWORK")
		button.Bullet:SetSize(10, 10)
		button.Bullet:SetPoint("LEFT", PAD_X + 6, 0)
		button.Label = button:CreateFontString(nil, "ARTWORK", "GameFontNormal")
		button.Label:SetPoint("LEFT", button.Bullet, "RIGHT", 8, 0)
		button.Label:SetPoint("RIGHT", -8, 0)
		button.Label:SetJustifyH("LEFT")
		button.Label:SetWordWrap(false)
		local hl = button:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAtlas("Options_List_Hover")
		hl:SetAllPoints()
		hl:SetAlpha(0.5)
		button:SetScript("OnEnter", function(self)
			if not self.desc or self.desc == "" then return end
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(self.Label:GetText(), 1, 0.82, 0)
			GameTooltip:AddLine(self.desc, 1, 1, 1, true)
			GameTooltip:Show()
		end)
		button:SetScript("OnLeave", function() GameTooltip:Hide() end)
	end
	button.desc = ed.desc
	if ed.checked ~= nil then
		button.Bullet:SetTexture(ed.checked and "Interface\\Buttons\\UI-CheckBox-Check" or "Interface\\Buttons\\UI-CheckBox-Up")
		button.Bullet:SetSize(16, 16)
	else
		button.Bullet:SetTexture("Interface\\Buttons\\WHITE8X8")
		button.Bullet:SetVertexColor(0.9, 0.9, 0.9)
		button.Bullet:SetSize(7, 7)
	end
	button.Label:SetText(ed.label)
	if ed.primary then button.Label:SetTextColor(1, 1, 1) else button.Label:SetTextColor(NORMAL_FONT_COLOR:GetRGB()) end
	button:SetScript("OnClick", function()
		PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		ed.onClick()
	end)
end

---------------------------------------------------------------------------

function T:Create(parent, header, composer)
	local inset = UI.Inset(parent)
	inset:SetPoint("TOPLEFT", header, "BOTTOMLEFT", -2, -4)
	inset:SetPoint("BOTTOMRIGHT", composer, "TOPRIGHT", 0, 4)
	self.inset, self.header, self.top = inset, header, header

	local scrollBox = CreateFrame("Frame", nil, inset, "WowScrollBoxList")
	scrollBox:SetPoint("TOPLEFT", 4, -4)
	scrollBox:SetPoint("BOTTOMRIGHT", -20, 4)
	local scrollBar = CreateFrame("EventFrame", nil, inset, "MinimalScrollBar")
	scrollBar:SetPoint("TOPLEFT", scrollBox, "TOPRIGHT", 4, 0)
	scrollBar:SetPoint("BOTTOMLEFT", scrollBox, "BOTTOMRIGHT", 4, 0)

	local view = CreateScrollBoxListLinearView(4, 8, 0, 0, 4)
	view:SetElementFactory(function(factory, ed)
		if ed.kind == "msg" then factory("OrcaMessageRowTemplate", InitMessage)
		elseif ed.kind == "option" then factory("OrcaOptionRowTemplate", InitOption)
		else factory("OrcaNoteRowTemplate", InitNote) end
	end)
	view:SetElementExtentCalculator(function(_, ed) return ed.height or 24 end)
	ScrollUtil.InitScrollBoxListWithScrollBar(scrollBox, scrollBar, view)
	self.scrollBox, self.scrollBar, self.view = scrollBox, scrollBar, view

	scrollBox:SetScript("OnSizeChanged", function() T:Relayout() end)
end

-- What the conversation hangs under: the header, or the family bar while it's shown.
function T:SetTop(anchor)
	anchor = anchor or self.header
	if anchor == self.top then return end
	self.top = anchor
	self.inset:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", -2, -4)
end

function T:Relayout()
	self.key = nil
	if ns.Main.frame and ns.Main.frame:IsShown() then self:Refresh() end
end

-- The bridge reformats messages (markdown, escapes), so the echo is matched by
-- time, not text: it goes once a message of yours arrives that is newer than the
-- newest message shown when you sent it. Both times come from T3 Code's clock.
-- (Message numbers won't do: T3 Code sends a bounded window and renumbers it.)
function T:AddLocalEcho(threadId, text)
	local after
	local v = ns.Store.data.view
	if v and v.id == threadId and not v.loading then
		after = 0
		for _, m in ipairs(v.msgs or {}) do
			if type(m.at) == "number" and m.at > after then after = m.at end
		end
	end
	self.echo[threadId] = { text = text, at = time(), after = after }
	self.followBottom = true
	self:Refresh(true)
end

---------------------------------------------------------------------------
-- Building the element list

T.heightFix = {} -- corrected row heights, by text and width

-- Without the thread's messages at send time, compare with this PC's clock, with
-- slack for a T3 Code server whose clock differs.
local function EchoArrived(echo, m)
	if echo.after then return type(m.at) == "number" and m.at > echo.after end
	return type(m.at) == "number" and m.at >= echo.at - 30
end

local function MessageElement(msg, echo)
	local width = T:BodyWidth()
	local fixKey = math.floor(width) .. ":" .. msg.t
	local height = math.max(34 + Measure(msg.t, width, BODY_FONT, BODY_SPACING), T.heightFix[fixKey] or 0)
	return { kind = "msg", msg = msg, echo = echo, height = height, fixKey = fixKey }
end

local function Note(text, icon, opts)
	local width = T:BodyWidth() - 22
	local e = { kind = "note", text = text, icon = icon, height = 14 + math.max(16, Measure(text, width, "GameFontNormal")) }
	if opts then for k, v in pairs(opts) do e[k] = v end end
	return e
end

local function Option(label, onClick, desc, extra)
	local e = { kind = "option", label = label, onClick = onClick, desc = desc, height = 26 }
	if extra then for k, v in pairs(extra) do e[k] = v end end
	return e
end

function T:AnswerQuestion(view, pending, q, value)
	local req = self.answers[pending.id] or {}
	self.answers[pending.id] = req
	if q.multi then
		req[q.id] = req[q.id] or {}
		req[q.id][value] = not req[q.id][value] or nil
	else
		req[q.id] = { [value] = true }
	end
	-- Single question, single choice: answer right away.
	if #pending.questions == 1 and not q.multi then
		self:SubmitAnswers(view.id, pending)
	else
		self:Refresh(true)
	end
end

function T:SubmitAnswers(threadId, pending, customText)
	local req = self.answers[pending.id] or {}
	local args = {}
	for _, q in ipairs(pending.questions) do
		local chosen = req[q.id]
		if chosen then
			for value in pairs(chosen) do
				table.insert(args, q.id)
				table.insert(args, value)
			end
		elseif customText and customText ~= "" then
			table.insert(args, q.id)
			table.insert(args, customText)
		end
	end
	if #args == 0 then return false end
	ns.Transport:Send("answer", threadId, pending.id, unpack(args))
	self.answered = self.answered or {}
	self.answered[pending.id] = true
	self:Refresh(true)
	return true
end

-- Called by the composer when a question is open and the player types an answer.
function T:CustomAnswer(text)
	local v = ns.Store:View()
	local p = v and v.pending
	if not p or p.kind ~= "question" then return false end
	for _, q in ipairs(p.questions) do
		if q.custom then return self:SubmitAnswers(v.id, p, text) end
	end
	return false
end

function T:Elements()
	local list = {}
	local main = ns.Main
	if main.mode == "new" then
		table.insert(list, Note(ns.Color("gold", "Start a new agent") .. "\n\nPick the workspace above, describe the task in the box below and press "
			.. ns.Color("white", "Start") .. ". It opens as a chat in Orca, on its default model.", "common-icon-forwardarrow"))
		return list
	end
	local id = ns.viewId
	if not id then
		local b = ns.Store.data.bridge or {}
		local lines = { ns.Color("gold", "Orca") .. (b.host and ns.Color("grey", "  on " .. b.host) or "") }
		local active = ns.Store:Active()
		if #active > 0 then
			table.insert(lines, string.format("\n%d agent%s need%s you or %s working.", #active, #active == 1 and "" or "s", #active == 1 and "s" or "", #active == 1 and "is" or "are"))
		end
		table.insert(lines, "\nPick an agent on the left to read it and reply, or start a new one.")
		if ns.Gamepad:IsActive() then
			table.insert(lines, "\n" .. ns.Gamepad:HelpText())
		end
		table.insert(list, Note(table.concat(lines, "\n"), "common-icon-forwardarrow"))
		return list
	end

	local t = ns.Store:Thread(id)
	local v = ns.Store:View()
	if not v then
		table.insert(list, Note(ns.Color("grey", "Loading…"), "common-icon-undo", { spin = true }))
		return list
	end
	if v.loading then
		table.insert(list, Note(ns.Color("grey", "Loading…"), "common-icon-undo", { spin = true }))
		return list
	end
	if v.more then
		table.insert(list, Note(ns.Color("grey", "Earlier messages are in Orca."), "common-icon-undo"))
	end
	local echo = self.echo[id]
	for _, m in ipairs(v.msgs or {}) do
		table.insert(list, MessageElement(m))
		if echo and m.r == "u" and EchoArrived(echo, m) then
			self.echo[id] = nil
			echo = nil
		end
	end
	if echo and time() - echo.at < 120 then
		table.insert(list, MessageElement({ r = "u", t = echo.text:gsub("|", "||"), at = echo.at }, true))
	end

	if v.err and t and t.s == "failed" then
		table.insert(list, Note(ns.Color("red", v.err), "common-icon-redx"))
	end

	local p = v.pending
	if p and not (self.answered and self.answered[p.id]) then
		if p.kind == "approval" then
			local body = ns.Color("orange", "The agent wants to " .. p.what:lower() .. ":")
			if p.files then
				for _, f in ipairs(p.files) do
					local delta = ""
					if f.a or f.d then delta = "  " .. ns.Color("green", "+" .. (f.a or 0)) .. " " .. ns.Color("red", "-" .. (f.d or 0)) end
					body = body .. "\n" .. ns.Color("white", f.f) .. delta
				end
			elseif p.detail ~= "" then
				body = body .. "\n" .. ns.Color("white", p.detail)
			end
			table.insert(list, Note(body, "common-icon-forwardarrow"))
			local function Approve(decision)
				return function()
					ns.Transport:Send("approve", id, p.id, decision)
					self.answered = self.answered or {}
					self.answered[p.id] = true
					self:Refresh(true)
				end
			end
			table.insert(list, Option("Approve", Approve("accept"), nil, { primary = true }))
			table.insert(list, Option("Approve for this session", Approve("acceptForSession")))
			if p.always then
				table.insert(list, Option("Always allow this", Approve("acceptAlways"), "Don't ask again for this command."))
			end
			table.insert(list, Option("Decline", Approve("decline")))
		elseif p.kind == "question" then
			local req = self.answers[p.id] or {}
			local custom = false
			for _, q in ipairs(p.questions) do
				local head = q.h and q.h ~= "" and (ns.Color("gold", q.h) .. "\n") or ""
				table.insert(list, Note(head .. ns.Color("white", q.q), "common-icon-forwardarrow"))
				for _, o in ipairs(q.opts) do
					local checked
					if q.multi or #p.questions > 1 then checked = (req[q.id] and req[q.id][o.v]) and true or false end
					table.insert(list, Option(o.l, function() T:AnswerQuestion(v, p, q, o.v) end, o.d, { checked = checked }))
				end
				if q.custom then custom = true end
			end
			if #p.questions > 1 or (p.questions[1] and p.questions[1].multi) then
				table.insert(list, Option("Submit answers", function() T:SubmitAnswers(id, p) end, nil, { primary = true }))
			end
			if custom then
				table.insert(list, Note(ns.Color("grey", "Or type your own answer below and press Send."), "common-icon-forwardarrow"))
			end
		end
	elseif t and t.s == "plan" then
		table.insert(list, Note(ns.Color("orange", "The agent has a plan ready") .. (v.plan and (":\n\n" .. v.plan) or "."), "common-icon-forwardarrow"))
		table.insert(list, Option("Read the plan aloud", function() ns.Speak(v.plan or "", id, "plan") end))
		table.insert(list, Option("Implement the plan", function() ns.Main:Send("Implement the plan.") end, nil, { primary = true }))
		table.insert(list, Option("Explain the plan more simply", function() ns.Main:Send("Explain the plan more simply.") end))
	end

	if v.sum then
		table.insert(list, Note(ns.Color("grey", v.sum), "common-icon-checkmark"))
	end
	if v.queued then
		table.insert(list, Note(ns.Color("orange", v.queued .. (v.queued == 1 and " follow-up is" or " follow-ups are") .. " queued until this run finishes."), "common-icon-undo"))
	end
	if t and (t.s == "working" or t.run) then
		table.insert(list, Note(ns.Color("agent", (t.run and t.l) or v.act or t.l or "Working"), "common-icon-undo", { spin = true, since = t.st, live = true }))
	elseif t and (t.s == "open" or t.s == "failed" or t.s == "waiting") and ns.db.settings.quickReplies and not ns.Store:ReadOnly(t) and not p then
		for _, text in ipairs(QUICK_REPLIES) do
			table.insert(list, Option(text:gsub("%.$", ""), function() ns.Main:Send(text) end))
		end
	end
	return list
end

-- Re-measure rows with the same elements (after a height correction).
function T:Reflow()
	if not self.scrollBox or not self.dp then return end
	local atBottom = not self.scrollBox:HasScrollableExtent() or self.scrollBox:GetScrollPercentage() > 0.97
	self.scrollBox:SetDataProvider(self.dp, ScrollBoxConstants.RetainScrollPosition)
	if atBottom then self.scrollBox:ScrollToEnd(ScrollBoxConstants.NoScrollInterpolation) end
end

function T:Refresh(force)
	if not self.scrollBox then return end
	local echo = ns.viewId and self.echo[ns.viewId]
	-- What the rows show besides the transcript itself: quick replies and the failed
	-- note follow the thread's status, and with no thread picked the note counts the
	-- active threads and names the machine. None of that is part of the transcript the
	-- bridge sends, so it goes in the key.
	local t = ns.Store:Thread(ns.viewId)
	local context
	if ns.viewId then
		context = t and ((t.s or "") .. "|" .. (t.l or "")) or "gone"
	else
		context = (ns.Store.listKey or "") .. "|" .. tostring((ns.Store.data.bridge or {}).host or "")
			.. "|" .. tostring(ns.Gamepad and ns.Gamepad:IsActive())
	end
	local key = table.concat({
		tostring(ns.viewId), ns.Store.viewKey or "", ns.Main.mode, context,
		echo and time() - echo.at < 120 and echo.at or 0, math.floor(self:BodyWidth()),
	}, ":")
	if key == self.key and not force then
		self.scrollBox:ForEachFrame(function(frame, ed)
			if ed.live then InitNote(frame, ed) end
		end)
		return
	end
	local viewChanged = self.lastViewId ~= ns.viewId
	self.key = key
	self.lastViewId = ns.viewId
	local atBottom = viewChanged or self.followBottom or not self.scrollBox:HasScrollableExtent() or self.scrollBox:GetScrollPercentage() > 0.97
	self.followBottom = nil
	local dp = CreateDataProvider(self:Elements())
	self.dp = dp
	self.scrollBox:SetDataProvider(dp, atBottom and ScrollBoxConstants.DiscardScrollPosition or ScrollBoxConstants.RetainScrollPosition)
	if atBottom then self.scrollBox:ScrollToEnd(ScrollBoxConstants.NoScrollInterpolation) end
	ns:Fire("TranscriptRebuilt")
end
