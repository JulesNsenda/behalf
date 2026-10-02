/*
 * Connect page: fills in the connector address and the Claude Code command from the page's own
 * origin, so the page is right on any host. Copy buttons are wired by ui.js through data-copy.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RoomView = window.RoomView;

  UI.byId('mcp-url').value = RoomView.mcpUrl(location.origin);
  UI.byId('mcp-command').textContent = RoomView.mcpCommand(location.origin);
})();
