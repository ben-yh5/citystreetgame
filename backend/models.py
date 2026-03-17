"""Pydantic models for API requests and responses."""

from pydantic import BaseModel
from typing import Optional


class CityLoadRequest(BaseModel):
    boundaries: dict  # GeoJSON geometry
    lat: float
    lon: float


class CityLoadResponse(BaseModel):
    city_id: str
    street_data: dict  # GeoJSON FeatureCollection
    street_names: list[str]
    total_length: float
    graph_stats: dict


class ClosestNodeRequest(BaseModel):
    city_id: str
    lat: float
    lng: float


class NodeInfo(BaseModel):
    node_id: int
    lat: float
    lng: float
    streets: list[str]


class ShortestPathRequest(BaseModel):
    city_id: str
    start_node: int
    end_node: int


class ShortestPathResponse(BaseModel):
    coordinates: list[list[float]]
    total_distance: float
    cues: list[dict]


class ChallengeRequest(BaseModel):
    city_id: str
    difficulty: str = 'major-major'
    start_node: Optional[int] = None
    end_node: Optional[int] = None


class ChallengeNode(BaseModel):
    node_id: int
    lat: float
    lng: float
    streets: list[str]


class InitRouteResponse(BaseModel):
    route_id: str
    starting_street: str
    current_node: NodeInfo
    route_coordinates: list[list[float]]
    continuation_coordinates: list[list[float]]
    confirmed_edge_count: int
    reached_end: bool
    end_coordinates: list[list[float]]
    name_changes: list[dict]


class ChallengeResponse(BaseModel):
    challenge_id: str
    start_node: ChallengeNode
    end_node: ChallengeNode
    route: InitRouteResponse


class ValidateCueRequest(BaseModel):
    route_id: str
    direction: str
    street_name: str


class ValidateCueResponse(BaseModel):
    valid: bool
    error: Optional[str] = None
    matched_street_name: Optional[str] = None
    current_street: Optional[str] = None
    current_node: Optional[NodeInfo] = None
    route_coordinates: list[list[float]] = []
    confirmed_coordinates: list[list[float]] = []
    continuation_coordinates: list[list[float]] = []
    confirmed_edge_count: int = 0
    reached_end: bool = False
    end_coordinates: list[list[float]] = []
    pre_turn_name_changes: list[dict] = []
    post_turn_name_changes: list[dict] = []


class UndoRequest(BaseModel):
    route_id: str
    cue_count: int  # number of explicit cues to keep


class HintRequest(BaseModel):
    route_id: str


class OptimalRouteRequest(BaseModel):
    city_id: str
    start_node: int
    end_node: int


class OptimalRouteResponse(BaseModel):
    coordinates: list[list[float]]
    cues: list[dict]
    total_distance: float


class IntersectionChallengeRequest(BaseModel):
    city_id: str
    difficulty: str = 'major-major'


class IntersectionLocation(BaseModel):
    lat: float
    lng: float


class IntersectionChallengeResponse(BaseModel):
    street1: str
    street2: str
    type1: str
    type2: str
    locations: list[IntersectionLocation]
    multiple_locations: bool
    location_count: int
