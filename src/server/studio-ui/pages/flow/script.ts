import { flowLayoutScript } from './layout.js';
import { flowPlanScript } from './plan-view.js';
import { flowTimeModelScript } from './timeline-model.js';
import { flowTimelineScript } from './timeline-view.js';

// Flow page: registration, header and click handling. Views live in the sibling files.
const flowMainScript = String.raw`  var ui = Studio.ui, fmt = Studio.fmt;
  var view = { mode: 'plan', implied: false };

  function flowHead(m) {
    var seg = function (mode, label) {
      return '<button type="button" data-act="flow-mode" data-mode="' + mode + '" aria-pressed="' + (view.mode === mode) + '">' + label + '</button>';
    };
    return '<div class="panel-head"><div class="panel-title"><h1>Flow</h1><p class="lead">' +
      (m ? ui.esc(m.name) : 'How the work in one milestone connects and how it actually ran.') + '</p></div>' +
      '<div class="panel-actions">' + ui.milestoneSelect() + '<div class="seg" role="group" aria-label="Flow view">' +
      seg('plan', 'Plan') + seg('timeline', 'What happened') + '</div></div></div>';
  }

  function flowShowFocus() {
    var id = Studio.state.focusTaskId;
    if (!id || typeof document === 'undefined') return;
    setTimeout(function () {
      var el = document.querySelector('#panel-flow [data-id="' + String(id).replace(/["\\]/g, '') + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }, 0);
  }

  Studio.registerPage('flow', {
    deps: ['tasks', 'telemetry', 'runs'],
    onShow: flowShowFocus,
    render: function (ctx) {
      var wanted = ctx.state.milestoneId || ctx.model.activeMilestoneId;
      var m = ctx.model.milestones.filter(function (x) { return x.id === wanted; })[0];
      if (!m) return flowHead(null) + ui.empty('No milestones yet', 'Add tasks to the plan to see them here.');
      if (ctx.state.focusTaskId) view.mode = 'plan';
      var body = !m.tasks.length ? ui.empty('This milestone has no tasks yet.', '')
        : view.mode === 'plan' ? flowPlan(m, ctx.state.focusTaskId, view) : flowTimeline(m, ctx);
      return flowHead(m) + body;
    },
    actions: {
      'flow-mode': function (el) {
        view.mode = el.getAttribute('data-mode') === 'timeline' ? 'timeline' : 'plan';
        Studio.state.focusTaskId = null;
        Studio.repaint('flow');
      },
      'flow-focus': function (el) {
        var id = el.getAttribute('data-id');
        if (Studio.state.focusTaskId === id) { Studio.closeDetail(); return; }
        Studio.state.focusTaskId = id;
        Studio.openTask(id);
        Studio.repaint('flow');
      },
      'flow-clear': function () { Studio.closeDetail(); },
      'flow-implied': function (el) {
        view.implied = !!el.checked;
        Studio.repaint('flow');
      }
    }
  });
`;

export const flowScript = [flowLayoutScript, flowPlanScript, flowTimeModelScript, flowTimelineScript, flowMainScript].join('');
