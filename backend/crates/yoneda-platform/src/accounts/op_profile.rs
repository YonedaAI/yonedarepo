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
    /// The GitHub App installation an account connected.
    pub(crate) enum GitHubOp {
        Get = "github_installation_get",
        Put = "github_installation_put",
    }
}
