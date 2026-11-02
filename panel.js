// @ts-check

import { h_flex, v_flex } from "gpui-base";
import { View, div } from "gpui-kit";
import { KgButton } from "gpui-component";
import { context, onContextChanged, toast } from "kagan/host";
import { closeSession, listSessions, openSession, prepare } from "./sessions.js";

/**
 * @typedef {{ id: string; threadId: string; state: string; headless?: boolean; createdAt?: number }} Session
 */

export class BrowserPanel extends View {
  init(_props, cx) {
    /** @type {Session[]} */
    this.sessions = [];
    this.busy = false;
    this.error = "";
    this.threadId = context().threadId ?? "";
    cx.spawn(async () => {
      for (;;) {
        await this.refresh(cx);
        await onContextChanged();
        this.threadId = context().threadId ?? "";
        cx.notify();
      }
    });
  }

  /** @param {import("gpui-kit").Context} cx */
  async refresh(cx) {
    try {
      this.sessions = (await listSessions(this.threadId || undefined)) ?? [];
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    cx.notify();
  }

  /** @param {import("gpui-kit").Context} cx */
  render(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .id("browser-automation-panel")
      .size_full()
      .p_3()
      .gap_3()
      .bg(colors.background)
      .text_color(colors.foreground)
      .child(div().text_sm().font_bold().child("Browser Automation"))
      .child(
        div()
          .text_xs()
          .text_color(colors.muted_foreground)
          .child("Local headless Chrome for this thread. Agents use kg browser-automation."),
      )
      .child(
        h_flex()
          .gap_2()
          .child(
            new KgButton("browser-open")
              .label(this.busy ? "Opening…" : "Open session")
              .disabled(this.busy)
              .on_click((_e, ctx) => this.open(ctx)),
          )
          .child(
            new KgButton("browser-refresh")
              .label("Refresh")
              .on_click((_e, ctx) => this.refresh(ctx)),
          ),
      )
      .when(Boolean(this.error), (el) =>
        el.child(div().id("browser-error").text_xs().text_color(colors.danger).child(this.error)),
      )
      .child(this.list(colors));
  }

  /** @param {import("gpui-kit").Context} cx */
  open(cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async () => {
      try {
        await prepare();
        await openSession({ threadId: this.threadId || undefined });
        toast("Browser session opened.");
        await this.refresh(cx);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        toast("Could not open a browser session.");
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  /** @param {any} colors */
  list(colors) {
    if (this.sessions.length === 0) {
      return div().text_xs().text_color(colors.muted_foreground).child("No sessions yet.");
    }
    return v_flex()
      .gap_2()
      .children(
        this.sessions.map((session) =>
          h_flex()
            .id(`browser-session-${session.id}`)
            .gap_2()
            .items_center()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_xs()
                .child(`${session.state} · ${session.id.slice(0, 8)}…`),
            )
            .child(
              new KgButton(`browser-close-${session.id}`)
                .label("Close")
                .on_click((_e, cx) => {
                  cx.spawn(async () => {
                    try {
                      await closeSession(session.id);
                      await this.refresh(cx);
                    } catch (error) {
                      this.error = error instanceof Error ? error.message : String(error);
                      cx.notify();
                    }
                  });
                }),
            ),
        ),
      );
  }
}
