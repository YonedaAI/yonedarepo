use yoneda_core::{FileEntry, Workspace};

pub(super) struct Case {
    pub(super) id: &'static str,
    pub(super) producer: &'static str,
    pub(super) consumer: &'static str,
    pub(super) head: &'static str,
    pub(super) candidate: &'static str,
    pub(super) repair: &'static str,
    pub(super) oracle: &'static str,
    pub(super) compatible: bool,
}

pub(super) fn cases() -> Vec<Case> {
    vec![
        Case {
            id: "compatible-capacity",
            producer: "export const allowed = e => e.attendees < e.capacity;",
            consumer: "import {allowed} from './producer.mjs'; export const act = e => ({ok:allowed(e)});",
            head: "export const allowed = e => Math.max(0,e.capacity-e.attendees)>0;",
            candidate: "import {allowed} from './producer.mjs'; export const act = e => ({ok:allowed(e),message:'Local confirmation'});",
            repair: "import {allowed} from './producer.mjs'; export const act = e => ({ok:allowed(e),message:'Local confirmation'});",
            oracle: "assert.equal(act({capacity:1,attendees:1}).ok,false); assert.equal(act({capacity:2,attendees:1}).ok,true);",
            compatible: true,
        },
        Case {
            id: "capacity-api-mismatch",
            producer: "export const allowed = e => e.attendees < e.capacity;",
            // Existing consumer tolerates a staged migration to a structured result.
            consumer: "import {allowed} from './producer.mjs'; export const act = e => {const a=allowed(e);return {ok:typeof a==='boolean'?a:a.allowed}};",
            head: "export const allowed = e => ({allowed:e.attendees<e.capacity,remaining:Math.max(0,e.capacity-e.attendees)});",
            // An independently correct simplification assumes the old boolean API.
            candidate: "import {allowed} from './producer.mjs'; export const act = e => ({ok:!!allowed(e),message:'Local confirmation'});",
            repair: "import {allowed} from './producer.mjs'; export const act = e => {const a=allowed(e);return {ok:typeof a==='boolean'?a:a.allowed,message:'Local confirmation'}};",
            oracle: "assert.equal(act({capacity:1,attendees:1}).ok,false,'full event must reject RSVP'); assert.equal(act({capacity:2,attendees:1}).ok,true);",
            compatible: false,
        },
        Case {
            id: "money-unit-mismatch",
            producer: "export const price = item => item.cents;",
            consumer: "import {price} from './producer.mjs'; export const act = item => {const p=price(item);return typeof p==='number'?p/100:p.dollars};",
            head: "export const price = item => ({dollars:item.cents/100,currency:'USD'});",
            candidate: "import {price} from './producer.mjs'; export const act = item => Math.round(price(item))/100;",
            repair: "import {price} from './producer.mjs'; export const act = item => {const p=price(item);return typeof p==='number'?Math.round(p)/100:Math.round(p.dollars*100)/100};",
            oracle: "assert.equal(act({cents:1299}),12.99,'charge must retain USD units'); assert.equal(act({cents:0}),0);",
            compatible: false,
        },
    ]
}

pub(super) fn workspace(producer: &str, consumer: &str) -> Workspace {
    [("producer.mjs", producer), ("consumer.mjs", consumer)]
        .into_iter()
        .map(|(path, source)| {
            (
                path.into(),
                FileEntry::from_bytes(format!("{source}\n").into_bytes(), false),
            )
        })
        .collect()
}
