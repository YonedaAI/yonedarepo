//! The commands on what an account keeps about itself: its picture, name, favorites and GitHub
//! connection.
use crate::ops::op_names;

op_names! {
    /// The account's picture: its source, what to serve, an upload and its removal.
    pub(crate) enum AvatarOp {
        Get = "avatar_get",
        Serve = "avatar_serve",
        Upload = "avatar_upload",
        Remove = "avatar_remove",
    }
}
op_names! {
    /// The name a person goes by.
    pub(crate) enum NameOp {
        Set = "name_set",
    }
}
op_names! {
    /// The repositories the account keeps at the top of its picker.
    pub(crate) enum FavoriteOp {
        List = "favorite_list",
        Put = "favorite_put",
        Remove = "favorite_remove",
    }
}
op_names! {
    /// The GitHub App installations an account connected, and the ticket that carries an
    /// organization's across the OAuth round proving an owner.
    pub(crate) enum GitHubOp {
        Get = "github_installation_get",
        List = "github_installation_list",
        Put = "github_installation_put",
        TicketPut = "github_org_ticket_put",
        TicketGet = "github_org_ticket_get",
        TicketTake = "github_org_ticket_take",
    }
}
